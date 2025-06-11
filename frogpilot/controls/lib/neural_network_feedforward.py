# Twilsonco's Lateral Neural Network Feedforward
#!/usr/bin/env python3
from collections import deque
from difflib import SequenceMatcher

import json
import math
import numpy as np
import os

from cereal import log
from openpilot.common.filter_simple import FirstOrderFilter
from openpilot.common.numpy_fast import interp
from openpilot.selfdrive.car.interfaces import LatControlInputs
from openpilot.selfdrive.controls.lib.drive_helpers import CONTROL_N
from openpilot.selfdrive.controls.lib.latcontrol import LatControl
from openpilot.selfdrive.controls.lib.pid import PIDController
from openpilot.selfdrive.controls.lib.vehicle_model import ACCELERATION_DUE_TO_GRAVITY
from openpilot.selfdrive.modeld.constants import ModelConstants

from openpilot.frogpilot.common.frogpilot_variables import TORQUE_NN_MODEL_PATH, params

# At higher speeds (25+mph) we can assume:
# Lateral acceleration achieved by a specific car correlates to
# torque applied to the steering rack. It does not correlate to
# wheel slip, or to speed.

# This controller applies torque to achieve desired lateral
# accelerations. To compensate for the low speed effects we
# use a LOW_SPEED_FACTOR in the error. Additionally, there is
# friction in the steering wheel that needs to be overcome to
# move it at all, this is compensated for too.

# dict used to rename activation functions whose names aren't valid python identifiers
ACTIVATION_FUNCTION_NAMES = {'σ': 'sigmoid'}

LOW_SPEED_X = [0, 10, 20, 30]
LOW_SPEED_Y = [15, 13, 10, 5]
LOW_SPEED_Y_NN = [12, 3, 1, 0]

LAT_PLAN_MIN_IDX = 5

class FluxModel:
  def __init__(self, params_file, zero_bias=False):
    with open(params_file, "r") as f:
      params = json.load(f)

    self.input_size = params["input_size"]
    self.output_size = params["output_size"]
    self.input_mean = np.array(params["input_mean"], dtype=np.float32).T
    self.input_std = np.array(params["input_std"], dtype=np.float32).T
    self.layers = []
    self.friction_override = False

    for layer_params in params["layers"]:
      W = np.array(layer_params[next(key for key in layer_params.keys() if key.endswith('_W'))], dtype=np.float32).T
      b = np.array(layer_params[next(key for key in layer_params.keys() if key.endswith('_b'))], dtype=np.float32).T
      if zero_bias:
        b = np.zeros_like(b)
      activation = layer_params["activation"]
      for k, v in ACTIVATION_FUNCTION_NAMES.items():
        activation = activation.replace(k, v)
      self.layers.append((W, b, activation))

    self.validate_layers()
    self.check_for_friction_override()

  # Begin activation functions.
  # These are called by name using the keys in the model json file
  @staticmethod
  def sigmoid(x):
    return 1 / (1 + np.exp(-x))

  @staticmethod
  def identity(x):
    return x
  # End activation functions

  def forward(self, x):
    for W, b, activation in self.layers:
      x = getattr(self, activation)(x.dot(W) + b)
    return x

  def evaluate(self, input_array):
    in_len = len(input_array)
    if in_len != self.input_size:
      # If the input is length 2-4, then it's a simplified evaluation.
      # In that case, need to add on zeros to fill out the input array to match the correct length.
      if 2 <= in_len:
        input_array = input_array + [0] * (self.input_size - in_len)
      else:
        raise ValueError(f"Input array length {len(input_array)} must be length 2 or greater")

    input_array = np.array(input_array, dtype=np.float32)

    # Rescale the input array using the input_mean and input_std
    input_array = (input_array - self.input_mean) / self.input_std

    output_array = self.forward(input_array)

    return float(output_array[0, 0])

  def validate_layers(self):
    for W, b, activation in self.layers:
      if not hasattr(self, activation):
        raise ValueError(f"Unknown activation: {activation}")

  def check_for_friction_override(self):
    y = self.evaluate([10.0, 0.0, 0.2])
    self.friction_override = (y < 0.1)

def get_lookahead_value(future_vals, current_val):
  if len(future_vals) == 0:
    return current_val

  same_sign_vals = [v for v in future_vals if sign(v) == sign(current_val)]

  # if any future val has opposite sign of current val, return 0
  if len(same_sign_vals) < len(future_vals):
    return 0.0

  # otherwise return the value with minimum absolute value
  min_val = min(same_sign_vals + [current_val], key=lambda x: abs(x))
  return min_val

def get_nn_model(car, eps_firmware) -> tuple[FluxModel | None, float]:
  model = get_nn_model_path(car, eps_firmware)
  if model is not None:
    model = FluxModel(model)
    params.put("NNFFModelName", car.replace("_", " "))
  return model

def get_nn_model_path(car, eps_firmware) -> tuple[str | None, float]:
  def check_nn_path(check_model):
    model_path = None
    max_similarity = -1.0
    for f in os.listdir(TORQUE_NN_MODEL_PATH):
      if f.endswith(".json"):
        model = f.replace(".json", "").replace(f"{TORQUE_NN_MODEL_PATH}/", "")
        similarity_score = similarity(model, check_model)
        if similarity_score > max_similarity:
          max_similarity = similarity_score
          model_path = os.path.join(TORQUE_NN_MODEL_PATH, f)
    return model_path, max_similarity

  if len(eps_firmware) > 3:
    eps_firmware = eps_firmware.replace("\\", "")
    check_model = f"{car} {eps_firmware}"
  else:
    check_model = car
  model_path, max_similarity = check_nn_path(check_model)
  if car not in model_path or 0.0 <= max_similarity < 0.9:
    check_model = car
    model_path, max_similarity = check_nn_path(check_model)
    if car not in model_path or 0.0 <= max_similarity < 0.9:
      model_path = None
  return model_path

def get_predicted_lateral_jerk(lat_accels, t_diffs):
  # compute finite difference between subsequent model_data.acceleration.y values
  # this is just two calls of np.diff followed by an element-wise division
  lat_accel_diffs = np.diff(lat_accels)
  lat_jerk = lat_accel_diffs / t_diffs
  # return as python list
  return lat_jerk.tolist()

# At a given roll, if pitch magnitude increases, the
# gravitational acceleration component starts pointing
# in the longitudinal direction, decreasing the lateral
# acceleration component. Here we do the same thing
# to the roll value itself, then passed to nnff.
def roll_pitch_adjust(roll, pitch):
  return roll * math.cos(pitch)

def sign(x):
  return 1.0 if x > 0.0 else (-1.0 if x < 0.0 else 0.0)

def similarity(s1: str, s2: str) -> float:
  return SequenceMatcher(None, s1, s2).ratio()

class NeuralNetworkFeedforward:
  def __init__(self, CP, CI, LatControlTorque):
    self.lat_control_torque = LatControlTorque
    self.pid = PIDController(self.lat_control_torque.torque_params.kp, self.lat_control_torque.torque_params.ki,
                             k_f=self.lat_control_torque.torque_params.kf, pos_limit=self.lat_control_torque.steer_max, neg_limit=-self.lat_control_torque.steer_max)
    self.torque_from_lateral_accel = CI.torque_from_lateral_accel()
    self.use_steering_angle = self.lat_control_torque.torque_params.useSteeringAngle
    self.steering_angle_deadzone_deg = self.lat_control_torque.torque_params.steeringAngleDeadzoneDeg

    self.lat_torque_nn_model = get_nn_model(CP.carFingerprint, str(next((fw.fwVersion for fw in CP.carFw if fw.ecu == "eps"), "")))

    lateral_delay = CP.steerActuatorDelay

    # Instantaneous lateral jerk changes very rapidly, making it not useful on its own,
    # however, we can "look ahead" to the future planned lateral jerk in order to guage
    # whether the current desired lateral jerk will persist into the future, i.e.
    # whether it's "deliberate" or not. This lets us simply ignore short-lived jerk.
    # Note that LAT_PLAN_MIN_IDX is defined above and is used in order to prevent
    # using a "future" value that is actually planned to occur before the "current" desired
    # value, which is offset by the steerActuatorDelay.
    self.friction_look_ahead_v = [1.4, 2.0] # how many seconds in the future to look ahead in [0, ~2.1] in 0.1 increments
    self.friction_look_ahead_bp = [9.0, 30.0] # corresponding speeds in m/s in [0, ~40] in 1.0 increments

    # Scaling the lateral acceleration "friction response" could be helpful for some.
    # Increase for a stronger response, decrease for a weaker response.
    self.lat_jerk_friction_factor = 0.4
    self.lat_accel_friction_factor = 0.7 # in [0, 3], in 0.05 increments. 3 is arbitrary safety limit

    # precompute time differences between ModelConstants.T_IDXS
    self.t_diffs = np.diff(ModelConstants.T_IDXS)
    self.desired_lat_jerk_time = lateral_delay + 0.3

    self.pitch = FirstOrderFilter(0.0, 0.5, 0.01)
    # NN model takes current v_ego, lateral_accel, lat accel/jerk error, roll, and past/future/planned data
    # of lat accel and roll
    # Past value is computed using previous desired lat accel and observed roll
    self.nn_friction_override = self.lat_torque_nn_model.friction_override

    # setup future time offsets
    self.nn_time_offset = lateral_delay + 0.2
    self.future_times = [0.3, 0.6, 1.0, 1.5] # seconds in the future
    self.nn_future_times = [i + self.nn_time_offset for i in self.future_times]
    self.nn_future_times_np = np.array(self.nn_future_times)

    # setup past time offsets
    self.past_times = [-0.3, -0.2, -0.1]
    history_check_frames = [int(abs(i)*100) for i in self.past_times]
    self.history_frame_offsets = [history_check_frames[0] - i for i in history_check_frames]
    self.lateral_accel_desired_deque = deque(maxlen=history_check_frames[0])
    self.roll_deque = deque(maxlen=history_check_frames[0])
    self.error_deque = deque(maxlen=history_check_frames[0])
    self.past_future_len = len(self.past_times) + len(self.nn_future_times)

    self.nn_log = None

  def update_live_delay(self, lateral_delay):
    self.desired_lat_jerk_time = lateral_delay + 0.3

    nn_time_offset = lateral_delay + 0.2
    self.nn_future_times = [i + nn_time_offset for i in self.future_times]
    self.past_future_len = len(self.past_times) + len(self.nn_future_times)

  def compute_ff(self, active, CS, VM, params, steer_limited, desired_curvature, llk, model_data, frogpilot_toggles):
    pid_log = log.ControlsState.LateralTorqueState.new_message()
    self.nn_log = None

    if not active:
      output_torque = 0.0
      pid_log.active = False
    else:
      actual_curvature_vm = -VM.calc_curvature(math.radians(CS.steeringAngleDeg - params.angleOffsetDeg), CS.vEgo, params.roll)
      roll_compensation = params.roll * ACCELERATION_DUE_TO_GRAVITY
      actual_lateral_jerk = 0.0
      if self.use_steering_angle:
        actual_curvature = actual_curvature_vm
        curvature_deadzone = abs(VM.calc_curvature(math.radians(self.steering_angle_deadzone_deg), CS.vEgo, 0.0))
        actual_curvature_rate = -VM.calc_curvature(math.radians(CS.steeringRateDeg), CS.vEgo, 0.0)
        actual_lateral_jerk = actual_curvature_rate * CS.vEgo ** 2
      else:
        actual_curvature_llk = llk.angularVelocityCalibrated.value[2] / CS.vEgo
        actual_curvature = interp(CS.vEgo, [2.0, 5.0], [actual_curvature_vm, actual_curvature_llk])
        curvature_deadzone = 0.0
      desired_lateral_accel = desired_curvature * CS.vEgo ** 2

      # desired rate is the desired rate of change in the setpoint, not the absolute desired curvature
      # desired_lateral_jerk = desired_curvature_rate * CS.vEgo ** 2
      actual_lateral_accel = actual_curvature * CS.vEgo ** 2
      lateral_accel_deadzone = curvature_deadzone * CS.vEgo ** 2

      low_speed_factor = interp(CS.vEgo, LOW_SPEED_X, LOW_SPEED_Y_NN if frogpilot_toggles.nnff else LOW_SPEED_Y)**2
      setpoint = desired_lateral_accel + low_speed_factor * desired_curvature
      measurement = actual_lateral_accel + low_speed_factor * actual_curvature

      lateral_jerk_setpoint = 0
      lateral_jerk_measurement = 0
      lookahead_lateral_jerk = 0

      model_good = model_data is not None and len(model_data.orientation.x) >= CONTROL_N
      if model_good:
        # prepare "look-ahead" desired lateral jerk
        lookahead = interp(CS.vEgo, self.friction_look_ahead_bp, self.friction_look_ahead_v)
        friction_upper_idx = next((i for i, val in enumerate(ModelConstants.T_IDXS) if val > lookahead), 16)
        predicted_lateral_jerk = get_predicted_lateral_jerk(model_data.acceleration.y, self.t_diffs)
        desired_lateral_jerk = (interp(self.desired_lat_jerk_time, ModelConstants.T_IDXS, model_data.acceleration.y) - desired_lateral_accel) / self.desired_lat_jerk_time
        lookahead_lateral_jerk = get_lookahead_value(predicted_lateral_jerk[LAT_PLAN_MIN_IDX:friction_upper_idx], desired_lateral_jerk)
        if not self.use_steering_angle or lookahead_lateral_jerk == 0.0:
          lookahead_lateral_jerk = 0.0
          actual_lateral_jerk = 0.0
          self.lat_accel_friction_factor = 1.0
        lateral_jerk_setpoint = self.lat_jerk_friction_factor * lookahead_lateral_jerk
        lateral_jerk_measurement = self.lat_jerk_friction_factor * actual_lateral_jerk

      if frogpilot_toggles.nnff and model_good:
        # update past data
        pitch = 0
        roll = params.roll
        if len(llk.calibratedOrientationNED.value) > 1:
          pitch = self.pitch.update(llk.calibratedOrientationNED.value[1])
          roll = roll_pitch_adjust(roll, pitch)
        self.roll_deque.append(roll)
        self.lateral_accel_desired_deque.append(desired_lateral_accel)

        # prepare past and future values
        # adjust future times to account for longitudinal acceleration
        adjusted_future_times = [t + 0.5*CS.aEgo*(t/max(CS.vEgo, 1.0)) for t in self.nn_future_times]
        past_rolls = [self.roll_deque[min(len(self.roll_deque)-1, i)] for i in self.history_frame_offsets]
        future_rolls = [roll_pitch_adjust(interp(t, ModelConstants.T_IDXS, model_data.orientation.x) + roll, interp(t, ModelConstants.T_IDXS, model_data.orientation.y) + pitch) for t in adjusted_future_times]
        past_lateral_accels_desired = [self.lateral_accel_desired_deque[min(len(self.lateral_accel_desired_deque)-1, i)] for i in self.history_frame_offsets]
        future_planned_lateral_accels = [interp(t, ModelConstants.T_IDXS[:CONTROL_N], model_data.acceleration.y) for t in adjusted_future_times]

        # compute NNFF error response
        nnff_setpoint_input = [CS.vEgo, setpoint, lateral_jerk_setpoint, roll] \
                              + [setpoint] * self.past_future_len \
                              + past_rolls + future_rolls
        # past lateral accel error shouldn't count, so use past desired like the setpoint input
        nnff_measurement_input = [CS.vEgo, measurement, lateral_jerk_measurement, roll] \
                                 + [measurement] * self.past_future_len \
                                 + past_rolls + future_rolls
        torque_from_setpoint = self.lat_torque_nn_model.evaluate(nnff_setpoint_input)
        torque_from_measurement = self.lat_torque_nn_model.evaluate(nnff_measurement_input)

        pid_log.error = torque_from_setpoint - torque_from_measurement
        error_blend_factor = interp(abs(desired_lateral_accel), [1.0, 2.0], [0.0, 1.0])
        if error_blend_factor > 0.0:  # blend in stronger error response when in high lat accel
          nnff_error_input = [CS.vEgo, setpoint - measurement, lateral_jerk_setpoint - lateral_jerk_measurement, 0.0]
          torque_from_error = self.lat_torque_nn_model.evaluate(nnff_error_input)
          if sign(pid_log.error) == sign(torque_from_error) and abs(pid_log.error) < abs(torque_from_error):
            pid_log.error = pid_log.error * (1.0 - error_blend_factor) + torque_from_error * error_blend_factor

        # compute feedforward (same as nn setpoint output)
        error = setpoint - measurement
        friction_input = self.lat_accel_friction_factor * error + self.lat_jerk_friction_factor * lookahead_lateral_jerk
        nn_input = [CS.vEgo, desired_lateral_accel, friction_input, roll] \
                   + past_lateral_accels_desired + future_planned_lateral_accels \
                   + past_rolls + future_rolls
        ff = self.lat_torque_nn_model.evaluate(nn_input)

        # apply friction override for cars with low NN friction response
        if self.nn_friction_override:
          pid_log.error += self.torque_from_lateral_accel(LatControlInputs(0.0, 0.0, CS.vEgo, CS.aEgo), self.lat_control_torque.torque_params,
                                                          friction_input, lateral_accel_deadzone, friction_compensation=True, gravity_adjusted=False)
        self.nn_log = nn_input + nnff_setpoint_input + nnff_measurement_input
      else:
        gravity_adjusted_lateral_accel = desired_lateral_accel - roll_compensation
        torque_from_setpoint = self.torque_from_lateral_accel(LatControlInputs(setpoint, roll_compensation, CS.vEgo, CS.aEgo), self.lat_control_torque.torque_params,
                                                              lateral_jerk_setpoint, lateral_accel_deadzone, friction_compensation=True, gravity_adjusted=False)
        torque_from_measurement = self.torque_from_lateral_accel(LatControlInputs(measurement, roll_compensation, CS.vEgo, CS.aEgo), self.lat_control_torque.torque_params,
                                                                 lateral_jerk_measurement, lateral_accel_deadzone, friction_compensation=True, gravity_adjusted=False)
        pid_log.error = torque_from_setpoint - torque_from_measurement
        error = desired_lateral_accel - actual_lateral_accel
        friction_input = self.lat_accel_friction_factor * error + self.lat_jerk_friction_factor * lookahead_lateral_jerk
        ff = self.torque_from_lateral_accel(LatControlInputs(gravity_adjusted_lateral_accel, roll_compensation, CS.vEgo, CS.aEgo), self.lat_control_torque.torque_params,
                                            friction_input, lateral_accel_deadzone, friction_compensation=True,
                                            gravity_adjusted=True)

      freeze_integrator = steer_limited or CS.steeringPressed or CS.vEgo < 5
      self.pid._k_p = frogpilot_toggles.steer_kp
      output_torque = self.pid.update(pid_log.error,
                                      feedforward=ff,
                                      speed=CS.vEgo,
                                      freeze_integrator=freeze_integrator)

      pid_log.active = True
      pid_log.p = self.pid.p
      pid_log.i = self.pid.i
      pid_log.d = self.pid.d
      pid_log.f = self.pid.f
      pid_log.output = -output_torque
      pid_log.actualLateralAccel = actual_lateral_accel
      pid_log.desiredLateralAccel = desired_lateral_accel
      pid_log.saturated = self.lat_control_torque._check_saturation(self.steer_max - abs(output_torque) < 1e-3, CS, steer_limited)
      if self.nn_log is not None:
        pid_log.nnLog = self.nn_log

    # TODO left is positive in this convention
    return output_torque, pid_log
