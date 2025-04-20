#!/usr/bin/env python3
from datetime import datetime
from flask import Flask, render_template, request, send_from_directory

import json
import os
import secrets

from openpilot.system.hardware import PC
from openpilot.system.hardware.hw import Paths

from openpilot.frogpilot.common.frogpilot_variables import ERROR_LOGS_PATH, params, params_cache
from openpilot.frogpilot.system.the_pond import helpers, utilities

FOOTAGE_PATHS = [Paths.log_root(konik=True), Paths.log_root(raw=True)]

def setup(app):
  @app.errorhandler(404)
  def not_found(_):
    return render_template("index.html")

  @app.route("/")
  def index():
    return render_template("index.html")

  @app.route("/api/navigation", methods=["DELETE"])
  def clear_navigation():
    params.remove("NavDestination")
    return {"message": "Destination cleared"}

  @app.route("/api/navigation", methods=["GET"])
  def navigation():
    last_position = json.loads(
      params.get("LastGPSPosition", encoding="utf8") or
      "{\"latitude\": 51.276824158421331, \"longitude\": 30.221928335547232, \"altitude\": 111.000000000000000}"
    )

    latitude = str(last_position["latitude"])
    longitude = str(last_position["longitude"])

    return {
      "mapboxToken": params_cache.get("MapboxPublicKey", encoding="utf8") or "",
      "lastPosition": {"latitude": latitude, "longitude": longitude},
      "destination": params.get("NavDestination", encoding="utf8") or "",
      "previousDestinations": params.get("ApiCache_NavDestinations", encoding="utf8") or "",
    }

  @app.route("/api/navigation", methods=["POST"])
  def set_navigation():
    params.put("NavDestination", json.dumps(request.json))
    return {"message": "Destination set"}

  @app.route("/api/routes")
  def list_routes():
    routes = []
    for footage_path in FOOTAGE_PATHS:
      for name in helpers.get_routes_names(footage_path):
        path = f"{footage_path}{name}--0"
        qcamera = f"{path}/qcamera.ts"

        utilities.video_to_gif(qcamera, f"{path}/preview.gif")
        utilities.video_to_png(qcamera, f"{path}/preview.png")

        routes.append({
          "name": name,
          "gif": f"/thumbnails/{name}--0/preview.gif",
          "png": f"/thumbnails/{name}--0/preview.png"
        })
    return routes, 200

  @app.route("/api/error_logs")
  def get_error_logs():
    if request.accept_mimetypes['text/html']:
      return render_template("v2/error-logs.jinja", active="error_logs")

    if request.accept_mimetypes['application/json']:
      return helpers.list_file(ERROR_LOGS_PATH), 200

  @app.route("/api/error_logs/<filename>")
  def get_error_log(filename):
    with open(os.path.join(ERROR_LOGS_PATH, filename)) as file:
      return file.read(), 200, {"Content-Type": "text/plain; charset=utf-8"}

  @app.route("/api/routes/<name>")
  def get_route(name):
    for footage_path in FOOTAGE_PATHS:
      base_path = f"{footage_path}{name}--0"
      if os.path.exists(base_path):
        segments = helpers.get_segments_in_route(name, footage_path)
        segment_urls = [f"/video/{segment}" for segment in segments]

        if not segment_urls:
          break

        last_segment_path = f"{footage_path}{name}--{len(segment_urls)-1}/qcamera.ts"
        last_duration = utilities.get_video_duration(last_segment_path)
        total_duration = round(last_duration + ((len(segment_urls) - 1) * 60))

        available_cameras = utilities.get_available_cameras(base_path)
        route_date = datetime.strptime(name, '%Y-%m-%d--%H-%M-%S')

        return {
          "name": name,
          "segment_urls": segment_urls,
          "total_duration": total_duration,
          "date": route_date,
          "available_cameras": available_cameras
        }, 200

    return {"error": "Route not found"}, 404

  @app.route("/api/stats")
  def get_stats():
    return {
      "driveStats": utilities.get_drive_stats(),
      "diskUsage": utilities.get_disk_usage()
    }

  @app.route("/thumbnails/<path:file_path>")
  def get_thumbnail(file_path):
    for footage_path in FOOTAGE_PATHS:
      try:
        return send_from_directory(footage_path, file_path, as_attachment=True)
      except FileNotFoundError:
        continue
    return {"error": "Thumbnail not found"}, 404

  @app.route("/video/<path>")
  def get_video(path):
    camera = request.args.get("camera")
    filename = {
      "driver": "dcamera.hevc",
      "wide": "ecamera.hevc"
    }.get(camera, "qcamera.ts")

    for footage_path in FOOTAGE_PATHS:
      filepath = f"{footage_path}{path}/{filename}"
      if os.path.exists(filepath):
        process = helpers.ffmpeg_mp4_wrap_process_builder(filepath)
        return Response(process.stdout.read(), status=200, mimetype="video/mp4")

    return {"error": "Video not found"}, 404

  @app.route("/playground")
  def playground():
    return render_template("playground.html")

def main():
  app = Flask(__name__, static_folder="assets", static_url_path="/assets")
  setup(app)

  debug = PC or __package__ == "the_pond"
  port = 8084 if debug else 8083

  if debug:
    print("\"The Pond\" is not running on a comma device, enabling debug mode")

  app.secret_key = secrets.token_hex(32)
  app.run(host="0.0.0.0", port=port, debug=debug)

if __name__ == "__main__":
  main()
