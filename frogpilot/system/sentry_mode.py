#!/usr/bin/env python3
import numpy as np
import time

import cereal.messaging as messaging

from openpilot.selfdrive.controls.lib.vehicle_model import ACCELERATION_DUE_TO_GRAVITY

ALARM_TIME = 30
CRASH_THRESHOLD = 1 * ACCELERATION_DUE_TO_GRAVITY
SENSITIVITY_THRESHOLD = 0.01 * ACCELERATION_DUE_TO_GRAVITY
TIME_INTERVAL = 1

class SentryMode:
  def __init__(self):
    self.trigger_alarm = False

    self.trigger_count = 0

    self.accel_magnitude_previous = None

    self.sm = messaging.SubMaster(["accelerometer"])

  def update(self):
    self.sm.update()

    accel_magnitude = np.linalg.norm(np.array(self.sm["accelerometer"].acceleration.v))
    if self.accel_magnitude_previous is None:
      self.accel_magnitude_previous = accel_magnitude
      return
    delta = abs(accel_magnitude - self.accel_magnitude_previous)

    if delta >= CRASH_THRESHOLD:
      self.trigger_count = ALARM_TIME / TIME_INTERVAL
    elif delta > SENSITIVITY_THRESHOLD:
      self.trigger_count += 1 if self.trigger_count < ALARM_TIME * 2 else 0
    elif self.trigger_count > 0:
      self.trigger_count -= 1

    self.trigger_alarm = self.trigger_count >= ALARM_TIME / TIME_INTERVAL

    self.accel_magnitude_previous = accel_magnitude

    time.sleep(TIME_INTERVAL)
