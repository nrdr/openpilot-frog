import { html, reactive } from "https://esm.sh/@arrow-js/core"
import { Link } from "./router.js"

export function Overview() {
  const state = reactive({
    data: "{}",
  })

  async function fetchData() {
    try {
      const response = await fetch("/api/stats")
      const json = await response.json()
      state.data = json

      if (json.diskError) {
        showSnackbar(json.diskError.join("<br>"), "error", 6000)
      }

      if (json.driveErrors) {
        showSnackbar(json.driveErrors.join("<br>"), "error", 6000)
      }
    } catch {
      showSnackbar("Failed to fetch stats", "error", 6000)
    }
  }

  fetchData()

  return html`
    <div>
      ${() => {
        const data = state.data
        if (!data) return html`<p>Loading...</p>`

        return html`
          <h1>The Pond</h1>
          <div class="drivingStats">
            ${DriveStat("All Time", data.driveStats?.all ?? {})}
            ${DriveStat("Past Week", data.driveStats?.week ?? {})}
            ${DriveStat("FrogPilot", data.driveStats?.frogpilot ?? {})}
          </div>

          <div class="diskUsage">
            <h2>Disk Usage</h2>
            ${data.diskError
              ? html`<p>${data.diskError.join("<br>")}</p>`
              : data.diskUsage?.map(DiskUsage)}
          </div>

          <div class="shortcuts">
            <h2>Shortcuts</h2>
            ${Link(
              "/navigation",
              html`
                <div class="shortcutLink">
                  <p>Set Navigation Destination</p>
                  <i class="bi bi-arrow-right"></i>
                </div>
              `
            )}
          </div>
        `
      }}
    </div>
  `
}

function DriveStat(title, stats) {
  const format = (n) =>
    n?.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }) ?? "0"

  return html`
    <div class="drivingStat">
      <h2>${title}</h2>
      <div><p>${format(stats.drives)}</p><p>drives</p></div>
      <div><p>${format(stats.distance)}</p><p>${stats.unit}</p></div>
      <div><p>${format(stats.hours)}</p><p>hours</p></div>
    </div>
  `
}

function DiskUsage(disk) {
  return html`
    <div class="disk">
      <h4>${disk.mount}</h4>
      <p>${disk.used} used of ${disk.size}</p>
      <div class="progress">
        <div class="bar" style="width: ${disk.usedPercentage}"></div>
      </div>
    </div>
  `
}
