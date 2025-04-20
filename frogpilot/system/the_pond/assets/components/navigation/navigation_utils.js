/**
 * Get the coordinates for a search value
 * @param {string} searchValue
 * @param {string} mapboxToken
 * @returns {Promise<number[]>} [longitude, latitude]
 */
export async function getCoordinatesFromSearch(searchValue, mapboxToken) {
  const params = new URLSearchParams({
    access_token: mapboxToken,
    q: searchValue,
  })
  const response = await fetch(
    `https://api.mapbox.com/search/geocode/v6/forward?${params.toString()}`
  )
  const data = await response.json()
  return data.features[0].geometry.coordinates
}

/**
 * Get a route from point A to point B
 * @param {string} from - "longitude,latitude"
 * @param {string} to - "longitude,latitude"
 * @param {string} mapboxToken
 * @returns {Promise<{ distance: number, duration: number, geometry: { type: string, coordinates: number[][] } }>}
 */
export async function getRoute(from, to, mapboxToken) {
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${from};${to}?geometries=geojson&access_token=${mapboxToken}`
  const route = await fetch(url)
  const routeData = await route.json()
  return routeData.routes[0]
}

/**
 * Adds a rendered route to the map
 * @param {object} map
 * @param {number[]} startingPoint
 * @param {number[]} destinationCoordinates
 * @param {number[][]} lineCoordinates
 */
export function addRouteToMap(map, startingPoint, destinationCoordinates, lineCoordinates) {
  const line = {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: lineCoordinates,
    },
  }

  if (map.getSource("route")) {
    map.removeLayer("route")
    map.removeSource("route")
  }

  map.addSource("route", {
    type: "geojson",
    data: line,
  })

  map.addLayer({
    id: "route",
    type: "line",
    source: "route",
    layout: {
      "line-join": "round",
      "line-cap": "round",
    },
    paint: {
      "line-color": "#5cd5eb",
      "line-width": 4,
    },
  })

  const padding = window.innerWidth < 600 ? 20 : 100
  map.fitBounds(
    [
      [startingPoint[0], startingPoint[1]],
      [destinationCoordinates[0], destinationCoordinates[1]],
    ],
    {
      padding,
      duration: 1000,
    }
  )
}

/**
 * Removes the current route from the map and centers the view
 * @param {object} map
 * @param {number[]} centeringPosition
 */
export function removeRouteFromMap(map, centeringPosition) {
  if (map.getSource("route")) {
    map.removeLayer("route")
    map.removeSource("route")
  }

  map.flyTo({
    center: centeringPosition,
    zoom: 15,
    speed: 3,
    pitch: 45,
  })
}

/**
 * Formats seconds to human readable time
 * @param {number} seconds
 * @returns {string}
 */
export function formatSecondsToHuman(seconds) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes} min` : `${minutes} min`
}

/**
 * Formats meters to human readable distance
 * @param {number} meters
 * @returns {string}
 */
export function formatMetersToHuman(meters) {
  return meters > 1000
    ? `${(meters / 1000).toFixed(1)} km`
    : `${meters} m`
}
