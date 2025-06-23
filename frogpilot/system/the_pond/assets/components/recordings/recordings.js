import { html, reactive } from "https://esm.sh/@arrow-js/core"
import { getOrdinalSuffix } from "../navigation/navigation_utils.js"

const state = reactive({
  loading: true,
  error: null,
  routes: [],
  selectedRoute: null,
  isButtonDisabled: false,
  showPreservedOnly: false,
  progress: 0,
  total: 0,
})

function formatRouteDate(dateString) {
  const date = new Date(dateString)
  const month = date.toLocaleString("en-US", { month: "long" })
  const day = date.getDate()
  const year = date.getFullYear()
  let hour = date.getHours()
  const minute = date.getMinutes()
  const ampm = hour >= 12 ? "pm" : "am"
  hour = hour % 12
  hour = hour || 12
  const minuteStr = minute < 10 ? "0" + minute : minute
  return `${month} ${day}${getOrdinalSuffix(day)}, ${year} - ${hour}:${minuteStr}${ampm}`
}

async function fetchRoutes() {
  try {
    const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const response = await fetch(`/api/routes?timezone=${encodeURIComponent(userTimezone)}`);
    if (!response.ok) throw new Error();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.substring(6));
            if (data.progress !== undefined && data.total !== undefined) {
              state.progress = data.progress;
              state.total = data.total;
            }
            if (data.routes) {
              const routes = data.routes.map(route => ({
                ...route,
                timestamp: formatRouteDate(route.timestamp),
              }));
              state.routes.push(...routes);
            }
          } catch (e) {
            console.error("Failed to parse JSON:", e);
          }
        }
      }
    }
  } catch (_) {
    state.error = "Couldn't load routes. Please try again later."
  } finally {
    state.loading = false
  }
}

fetchRoutes()

function refresh() {
  state.loading = true
  state.routes = []
  fetchRoutes()
}

let overlay = null

function openDialog(htmlStr) {
  const o = document.createElement("div")
  o.className = "dialog-overlay"
  o.innerHTML = htmlStr
  document.body.appendChild(o)
  return o
}

function closeDialog(o) {
  if (o) o.remove()
}

async function deleteRoute(route) {
  const dlg = openDialog(`    <div class="dialog-box">
      <p>Delete “${route.timestamp}”?</p>
      <div class="dialog-buttons">
        <button class="btn-cancel">Cancel</button>
        <button class="btn-del">Delete</button>
      </div>
    </div>`);
  dlg.querySelector(".btn-cancel").onclick = () => closeDialog(dlg)
  dlg.querySelector(".btn-del").onclick = async () => {
    const res = await fetch(`/api/routes/${route.name}`, { method: "DELETE" })
    if (res.ok) {
      closeDialog(dlg)
      closeOverlay()
      refresh()
    } else {
      showSnackbar("Delete failed...", "error")
    }
  }
}

async function openOverlay(route) {
  if (overlay) return;
  state.isButtonDisabled = true;

  let segments;
  try {
    const response = await fetch(`/api/routes/${route.name}`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    segments = data.segment_urls;

    if (!segments || segments.length === 0) {
      segments = [`/video/${route.name}--0`];
      console.warn("Route API returned no segments, falling back to segment 0.");
    }
  } catch (error) {
    console.error("Could not fetch route segments:", error);
    showSnackbar("Error: Could not load all route segments.", "error");
    segments = [`/video/${route.name}--0`];
  }

  let current = 0;
  let selectedCamera = "forward";
  overlay = document.createElement("div");
  overlay.className = "media-player-overlay";
  overlay.innerHTML = `    <div class="media-player-content">
      <div class="media-player-title">${route.timestamp}</div>
      <video controls autoplay muted>
        <source src="${segments[0]}" type="video/mp4">
      </video>
      <div class="button-row">
        <button class="close-button action-close">Close</button>
        <button class="close-button camera-button active" data-camera="forward">Forward</button>
        <button class="close-button camera-button" data-camera="wide">Wide</button>
        <button class="close-button camera-button" data-camera="driver">Driver</button>
        <button class="close-button action-download">Download</button>
        <button class="close-button action-delete">Delete</button>
      </div>
    </div>`;
  overlay.addEventListener("click", e => {
    if (e.target === overlay) closeOverlay();
  });
  overlay.querySelector(".action-close").onclick = closeOverlay;
  overlay.querySelector(".action-delete").onclick = () => deleteRoute(route);
  overlay.querySelector(".action-download").onclick = () => {
    const link = document.createElement('a');
    const videoPath = `/video/${route.name}--${current}?camera=${selectedCamera}`;
    link.href = videoPath;
    link.download = `${route.name}-${selectedCamera}.mp4`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  const vid = overlay.querySelector("video");
  vid.addEventListener("ended", () => {
    current++;
    if (current < segments.length) {
      const videoPath = segments[current].includes('?') ? `${segments[current]}&camera=${selectedCamera}` : `${segments[current]}?camera=${selectedCamera}`
      vid.src = videoPath;
      vid.load();
      vid.play();
    }
  });
  overlay.querySelectorAll(".camera-button").forEach(button => {
    button.addEventListener("click", e => {
      overlay.querySelectorAll(".camera-button").forEach(btn => btn.classList.remove("active"));
      e.target.classList.add("active");
      selectedCamera = e.target.dataset.camera;
      const videoPath = segments[current].includes('?') ? `${segments[current]}&camera=${selectedCamera}` : `${segments[current]}?camera=${selectedCamera}`
      vid.src = videoPath;
      vid.load();
      vid.play();
    });
  });
  document.body.appendChild(overlay);
  setTimeout(() => {
    state.isButtonDisabled = false;
  }, 2000);
}

function closeOverlay() {
  if (!overlay) return
  overlay.remove()
  overlay = null
  state.selectedRoute = null
}

async function togglePreserved(route, e) {
  e.stopPropagation()
  const newPreservedState = !route.is_preserved
  const method = newPreservedState ? "POST" : "DELETE"
  try {
    const response = await fetch(`/api/routes/${route.name}/preserve`, { method })
    if (response.ok) {
      route.is_preserved = newPreservedState
    } else {
      const errorData = await response.json()
      showSnackbar(errorData.error || "Failed to update preserved state...", "error")
    }
  } catch (_) {
    showSnackbar("An error occurred...", "error")
  }
}

export function RouteRecordings() {
  if (state.selectedRoute && !overlay) openOverlay(state.selectedRoute)
  return html`    <div class="screen-recordings-wrapper">
      <div class="screen-recordings-widget">
        <div class="screen-recordings-title">Dashcam Routes</div>
        <button
          class="show-preserved-button"
          @click="${() => (state.showPreservedOnly = !state.showPreservedOnly)}"
          ?disabled="${state.loading && state.routes.length === 0}"
        >
          ${() => (state.showPreservedOnly ? "Show All" : "Show Only Preserved Routes")}
        </button>
        ${() => {
          const routesToShow = state.routes.filter(r => !state.showPreservedOnly || r.is_preserved)

          return html`            ${(state.loading && state.total > 0) ? html`<p class="screen-recordings-message">Processing Routes: ${state.progress} of ${state.total}</p>` : ''}

            ${(state.loading && routesToShow.length === 0) ? html`<p class="screen-recordings-message">Loading…</p>` : ''}
            ${(state.error && routesToShow.length === 0) ? html`<p class="screen-recordings-message">${state.error}</p>` : ''}
            ${(!state.loading && routesToShow.length === 0) ? html`<p class="screen-recordings-message">No routes found.</p>` : ''}

            ${(routesToShow.length > 0) ? html`              <div class="screen-recordings-grid">
                ${routesToShow.map(
                  route => html`                    <div
                      class="recording-card"
                      @mouseenter="${e => {
                        if (!state.selectedRoute) {
                          const card = e.currentTarget;
                          const gif = card.querySelector('.recording-preview-gif');
                          const png = card.querySelector('.recording-preview-png');

                          if (card.dataset.gifLoaded) {
                            png.style.display = 'none';
                            gif.style.display = 'block';
                            return;
                          }

                          const preloader = new Image();
                          preloader.onload = () => {
                            gif.src = preloader.src;
                            png.style.display = 'none';
                            gif.style.display = 'block';
                            card.dataset.gifLoaded = true;
                          };
                          preloader.onerror = () => {
                            console.error('Failed to load preview GIF:', preloader.src);
                          };

                          preloader.src = gif.dataset.src;
                        }
                      }}"
                      @mouseleave="${e => {
                        const card = e.currentTarget
                        card.querySelector('.recording-preview-png').style.display = 'block'
                        card.querySelector('.recording-preview-gif').style.display = 'none'
                      }}"
                      @click="${() => {
                        if (!state.isButtonDisabled) {
                          state.selectedRoute = route
                        }
                      }}"
                    >
                      <div class="preserved-icon" @click="${e => togglePreserved(route, e)}">
                        ${() => html`<i class="bi ${route.is_preserved ? "bi-heart-fill" : "bi-heart"}"></i>`}
                      </div>
                      <div class="recording-preview-container">
                        <img
                          src="${route.png}"
                          class="recording-preview recording-preview-png"
                          style="display:block;"
                        >
                        <img
                          data-src="${route.gif}"
                          class="recording-preview recording-preview-gif"
                          style="display:none;"
                        >
                      </div>
                      <p class="recording-filename">${route.timestamp}</p>
                    </div>
                  `,
                )}
              </div>
            ` : ''}
          `}}
      </div>
    </div>
  `
}
