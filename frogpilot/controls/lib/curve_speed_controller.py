#!/usr/bin/env python3
import json
import numpy as np

from openpilot.common.realtime import DT_MDL

from openpilot.frogpilot.common.frogpilot_variables import CRUISING_SPEED, DEFAULT_LATERAL_ACCELERATION, PLANNER_TIME, params

CALIBRATION_PROGRESS_THRESHOLD = (60 * 5) / DT_MDL

class CurveSpeedController:
  def __init__(self, FrogPilotVCruise):
    self.frogpilot_planner = FrogPilotVCruise.frogpilot_planner

    self.enable_training = False
    self.target_set = False

    self.training_timer = 0

    self.lateral_acceleration = json.loads(params.get("UserLateralAcceleration") or "{}")

    self.lateral_acceleration.setdefault("total_count", 1)
    self.lateral_acceleration.setdefault("total_sum", DEFAULT_LATERAL_ACCELERATION)

    self.user_target_accel = self.lateral_acceleration["total_sum"] / self.lateral_acceleration["total_count"]

  def log_data(self, v_ego, sm):
    self.enable_training = v_ego > CRUISING_SPEED
    self.enable_training &= not self.frogpilot_planner.tracking_lead
    self.enable_training &= not sm["carControl"].longActive
    self.enable_training &= not (sm["carState"].leftBlinker or sm["carState"].rightBlinker)

    if self.enable_training:
      self.training_timer += DT_MDL

      if self.training_timer >= PLANNER_TIME and self.frogpilot_planner.driving_in_curve:
        self.lateral_acceleration["total_count"] += 1
        self.lateral_acceleration["total_sum"] += abs(self.frogpilot_planner.lateral_acceleration)
      else:
        self.enable_training = False

    elif self.training_timer >= PLANNER_TIME:
      self.user_target_accel = self.lateral_acceleration["total_sum"] / self.lateral_acceleration["total_count"]

      params.put_nonblocking("UserLateralAcceleration", json.dumps(self.lateral_acceleration))
      params.put_int_nonblocking("CalibrationProgress", min((self.lateral_acceleration["total_count"] / CALIBRATION_PROGRESS_THRESHOLD) * 100, 100))

      self.enable_training = False

      self.training_timer = 0

    else:
      self.enable_training = False

      self.training_timer = 0

  def update_target(self, v_ego):
    csc_speed = (self.user_target_accel / abs(self.frogpilot_planner.road_curvature))**0.5

    if self.target_set:
      decel_rate = (v_ego - csc_speed) / self.frogpilot_planner.time_to_curve
      self.target -= decel_rate * DT_MDL
      self.target = float(np.clip(self.target, CRUISING_SPEED, csc_speed))
    else:
      self.target_set = True

      self.target = v_ego
