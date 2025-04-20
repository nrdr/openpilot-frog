import { createBrowserHistory, createRouter } from "https://esm.sh/@remix-run/router@1.3.1"
import { html, reactive } from "https://esm.sh/@arrow-js/core"
import { Sidebar } from "./sidebar.js"
import { Overview } from "./overview.js"
import { SettingsView } from "./settings/settings.js"
import { NavDestination } from "./navigation/navigation_destination.js"
import { ErrorLogs } from "./error_logs.js"
import { RecordedRoutes, RecordedRoute } from "./recordings/recordings.js"
import { hideSidebar } from "../js/utils.js"

let router, routerState

function createRoute(id, path, component) {
  return {
    id,
    path,
    loader: () => {},
    element: component,
  }
}

function Root() {
  let routes = [
    createRoute("root", "/", Overview),
    createRoute("routes", "/routes", RecordedRoutes),
    createRoute("route", "/routes/:routeDate", RecordedRoute),
    createRoute("settings", "/settings/:section/:subsection?", SettingsView),
    createRoute("navdestination", "/navigation", NavDestination),
    createRoute("errorLogs", "/error_logs", ErrorLogs),
  ]

  router = createRouter({
    routes,
    history: createBrowserHistory(),
  }).initialize()

  routerState = reactive({
    activePath: "/",
    activePathFull: "/",
    initialized: false,
    navigation: { state: "loading" },
    errors: [],
    params: {},
  })

  router.subscribe(({ initialized, navigation, matches, errors }) => {
    const [match] = matches
    Object.assign(routerState, {
      initialized,
      activePath: match.route.path,
      activePathFull: match.pathname,
      navigation,
      params: match.params,
      errors,
    })
  })

  return html`
    ${() => Sidebar(routerState.activePathFull)}
    <div class="content">
      ${() => {
        if (!routerState.initialized || routerState.navigation.state === "loading") {
          return html`<div>Loading...</div>`
        }

        if (routerState.errors?.root?.status === 404) {
          return html`<h1>Not Found</h1>`
        }

        const match = routes.find(r => r.path === routerState.activePath)
        return match.element({ params: routerState.params })
      }}
    </div>
  `
}

export function Link(href, children, onClick, classes = "") {
  return html`<a
    class="${classes}"
    href="${() => href}"
    @click="${(e) => {
      e.preventDefault()
      router.navigate(e.currentTarget.href)
      hideSidebar()
      onClick?.()
    }}"
  >${children}</a>`
}

export function Navigate(href) {
  router.navigate(href)
  window.scrollTo(0, 0)
}

Root()(document.getElementById("app"))
