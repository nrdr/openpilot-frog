import { html, reactive } from "https://esm.sh/@arrow-js/core"
import { Link } from "./router.js"
import { upperFirst, hideSidebar } from "../js/utils.js"

const MenuItems = {
  navigation: [
    { name: "Manage Keys", link: "/navigation", icon: "bi-key-fill" },
    { name: "Set destination", link: "/navigation", icon: "bi-globe-americas" },
  ],
  recordings: [
    { name: "Dashcam Routes", link: "/routes", icon: "bi-camera-reels" },
    { name: "Saved routes", link: "/saved_routes", icon: "bi-box2-heart" },
    { name: "Screen recordings", link: "/screen_recordings", icon: "bi-record-circle" },
  ],
  tools: [
    { name: "Capture Tmux Log", link: "", icon: "bi-terminal" },
    { name: "Download Speed Limits", link: "", icon: "bi-download" },
    { name: "Error logs", link: "/error_logs", icon: "bi-exclamation-triangle" },
    { name: "Lock/Unlock Doors", link: "", icon: "bi-door-closed" },
    { name: "Toggles", link: "", icon: "bi-toggle-on" },
  ],
}

export function Sidebar(activePath) {
  const activeItem = Object.values(MenuItems).flat().find(item => item.link === activePath)
  const state = reactive({ activeRoute: activeItem?.name ?? "" })

  function navigate(link) {
    state.activeRoute = link.name
    window.scrollTo(0, 0)
    hideSidebar()
  }

  return html`
    <div id="sidebarUnderlay" class="hidden"></div>
    <div id="sidebar" class="sidebar">
      <div>
        <div class="title">
          ${Link(
            "/",
            html`<img class="logo" src="/assets/images/main_logo.png" alt="FrogPilot logo" />`
          )}
          <div class="title_text">
            ${Link("/", html`<p>The Pond</p>`)}
            <a href="https://github.com/Aidenir">by&nbsp;Aidenir</a>
          </div>
        </div>
        <hr />
        ${Object.entries(MenuItems).map(([section, links]) => html`
          <ul class="menu_section">
            <li>
              <a href="#"><span>${upperFirst(section)}</span></a>
              <ul id="${section}">
                ${links.map(link => {
                  const isActive = state.activeRoute === link.name
                  const isEmpty = !link.link
                  const classList = [isEmpty && "not_implemented", isActive && "active"].filter(Boolean).join(" ")

                  return html`
                    <li class="${classList}">
                      <i class="bi ${link.icon}"></i>
                      ${isEmpty
                        ? html`<a href="#">${upperFirst(link.name)}</a>`
                        : Link(link.link, upperFirst(link.name), () => navigate(link))
                      }
                    </li>`
                })}
              </ul>
            </li>
          </ul>
        `)}
      </div>
    </div>`
}

function setupMenuButton() {
  const button = document.getElementById("menu_button")
  const sidebar = document.getElementById("sidebar")
  const underlay = document.getElementById("sidebarUnderlay")

  button.addEventListener("click", () => {
    sidebar.classList.toggle("visible")
    underlay.classList.toggle("hidden")
  })

  underlay.addEventListener("click", hideSidebar)
}

document.addEventListener("DOMContentLoaded", setupMenuButton, false)
