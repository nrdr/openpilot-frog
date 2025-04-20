import { html, reactive } from "https://esm.sh/@arrow-js/core"
import {
  addRouteToMap,
  formatMetersToHuman,
  formatSecondsToHuman,
  getCoordinatesFromSearch,
  getRoute,
  removeRouteFromMap,
} from "./navigation_utils.js"

export function NavDestination() {
  let map
  let destinationMarker

  const state = reactive({
    mapboxToken: undefined,
    initialized: false,
    lastPosition: undefined,
    destination: undefined,
    route: undefined,
    suggestions: "[]",
    previousDestinations: "[]",
  })

  const searchFieldState = reactive({ value: "" })

  async function getNavigationData() {
    const response = await fetch("/api/navigation")
    const data = await response.json()

    state.mapboxToken = data.mapboxToken.trim()
    state.lastPosition = {
      latitude: parseFloat(data.lastPosition.latitude),
      longitude: parseFloat(data.lastPosition.longitude),
    }

    try {
      state.destination = JSON.parse(data.destination)
    } catch {}

    try {
      const previous = JSON.parse(data.previousDestinations)
      state.previousDestinations = previous.map(d => ({ name: d.place_name }))
      state.suggestions = [...state.previousDestinations]
    } catch {}

    setupMap()
  }

  async function searchInput(e) {
    searchFieldState.value = e.target.value
    clearTimeout(window.searchTimeout)

    window.searchTimeout = setTimeout(async () => {
      const searchValue = e.target.value.trim()
      if (searchValue.length < 3) return

      state.route = undefined

      const lastPosition = `${state.lastPosition.longitude},${state.lastPosition.latitude}`
      const params = new URLSearchParams({
        proximity: lastPosition,
        access_token: state.mapboxToken,
        session_token: "sfsf",
        q: searchValue,
        limit: 4,
      })
      const response = await fetch(
        `https://api.mapbox.com/search/searchbox/v1/suggest?${params.toString()}`
      )
      const data = await response.json()
      state.suggestions = JSON.stringify(data.suggestions)
    }, 800)
  }

  const setupMap = async () => {
    if (!state.mapboxToken || state.initialized) return
    state.initialized = true

    mapboxgl.accessToken = state.mapboxToken

    map = new mapboxgl.Map({
      container: "map",
      center: [state.lastPosition.longitude, state.lastPosition.latitude],
      zoom: 15,
      pitch: 45,
      attributionControl: false,
      logoPosition: "bottom-right",
      style: "mapbox://styles/mapbox/dark-v11",
    })

    destinationMarker = new mapboxgl.Marker()
    new mapboxgl.Marker()
      .setLngLat([state.lastPosition.longitude, state.lastPosition.latitude])
      .addTo(map)

    map.on("style.load", async () => {
      const layers = map.getStyle().layers
      const labelLayer = layers.find(
        layer => layer.type === "symbol" && layer.layout["text-field"]
      ).id

      map.addLayer(
        {
          id: "add-3d-buildings",
          source: "composite",
          "source-layer": "building",
          filter: ["==", "extrude", "true"],
          type: "fill-extrusion",
          minzoom: 15,
          paint: {
            "fill-extrusion-color": "#aaa",
            "fill-extrusion-height": [
              "interpolate", ["linear"], ["zoom"], 15, 0, 15.05, ["get", "height"]
            ],
            "fill-extrusion-base": [
              "interpolate", ["linear"], ["zoom"], 15, 0, 15.05, ["get", "min_height"]
            ],
            "fill-extrusion-opacity": 0.6,
          },
        },
        labelLayer
      )

      if (state.destination) {
        const coordinates = [
          state.destination.longitude,
          state.destination.latitude,
        ]

        destinationMarker.setLngLat(coordinates).addTo(map)

        const route = await getRoute(
          `${state.lastPosition.longitude},${state.lastPosition.latitude}`,
          `${coordinates[0]},${coordinates[1]}`,
          state.mapboxToken
        )

        addRouteToMap(map, [state.lastPosition.longitude, state.lastPosition.latitude], coordinates, route.geometry.coordinates)

        state.route = {
          name: state.destination.name,
          duration: route.duration,
          distance: route.distance,
          destinationCoordinates: coordinates,
          startingCoordinates: [
            state.lastPosition.longitude,
            state.lastPosition.latitude,
          ],
          confirmed: true,
        }
      }
    })
  }

  getNavigationData()

  return html`
    <h1>Navigation</h1>
    <div class="map-wrapper">
      <div class="search-wrapper">
        <input
          id="search-field"
          placeholder="Search here"
          value="${() => searchFieldState.value}"
          @input="${searchInput}"
        />
        <div id="infobox">
          ${() => {
            if (state.route) {
              return NavigationDestination({
                ...state.route,
                map,
                cancelNavigationFn: () => {
                  state.route = undefined
                  state.suggestions = state.previousDestinations
                },
              })
            } else if (JSON.parse(state.suggestions).length > 0) {
              return SearchSuggestions({
                suggestions: JSON.parse(state.suggestions),
                mapboxToken: state.mapboxToken,
                map,
                lastPosition: state.lastPosition,
                destinationMarker,
                setRouteFn: route => {
                  state.route = route
                },
              })
            }
          }}
        </div>
      </div>
      <div id="map"></div>
    </div>
  `
}

function SearchSuggestions({
  suggestions,
  mapboxToken,
  map,
  lastPosition,
  destinationMarker,
  setRouteFn,
}) {
  function formatSuggestion(suggestion) {
    return [suggestion.name, suggestion.place_formatted]
      .filter(Boolean)
      .join(", ")
  }

  const clickHandler = async suggestion => {
    const searchQuery = formatSuggestion(suggestion)
    document.getElementById("search-field").value = searchQuery

    const coordinates = await getCoordinatesFromSearch(searchQuery, mapboxToken)
    destinationMarker.setLngLat(coordinates).addTo(map)

    const route = await getRoute(
      `${lastPosition.longitude},${lastPosition.latitude}`,
      `${coordinates[0]},${coordinates[1]}`,
      mapboxToken
    )

    addRouteToMap(map, [lastPosition.longitude, lastPosition.latitude], coordinates, route.geometry.coordinates)

    setRouteFn({
      name: searchQuery,
      duration: route.duration,
      distance: route.distance,
      destinationCoordinates: coordinates,
      startingCoordinates: [lastPosition.longitude, lastPosition.latitude],
    })
  }

  const suggestionItem = suggestion => html`
    <span @click="${() => clickHandler(suggestion)}">
      <p>${formatSuggestion(suggestion)}</p>
    </span>
  `

  return html`<div id="searchSuggestions">${suggestions.map(suggestionItem)}</div>`
}

function NavigationDestination({
  name,
  duration,
  distance,
  confirmed,
  destinationCoordinates,
  startingCoordinates,
  map,
  cancelNavigationFn,
}) {
  const state = reactive({ confirmed: confirmed ?? false })

  async function confirmDestination() {
    state.confirmed = true
    showSnackbar("Navigation saved")
    await fetch("/api/navigation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        longitude: destinationCoordinates[0],
        latitude: destinationCoordinates[1],
      }),
    })
  }

  async function cancelNavigation() {
    state.confirmed = false
    showSnackbar("Navigation cancelled")
    removeRouteFromMap(map, startingCoordinates)
    cancelNavigationFn()
    await fetch("/api/navigation", { method: "DELETE" })
  }

  return html`
    <div id="navigationSummary">
      <p>${name}</p>
      <p>${formatSecondsToHuman(duration)}, ${formatMetersToHuman(distance)}</p>
      <div class="buttonCluster">
        ${() =>
          state.confirmed
            ? html`<button class="cancel" @click="${cancelNavigation}">
                <i class="bi bi-x-lg"></i> Cancel navigation
              </button>`
            : html`<button class="directions" @click="${confirmDestination}">
                <i class="bi bi-sign-turn-right"></i> Directions
              </button>`}
        <button class="favorite">
          <i class="bi bi-suit-heart-fill"></i>
        </button>
      </div>
    </div>
  `
}
