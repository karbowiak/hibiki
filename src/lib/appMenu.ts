import { Menu, Submenu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu"

export async function createAppMenu(onSettings: () => void) {
  const sep = () => PredefinedMenuItem.new({ item: "Separator" })

  // ── Plexify (app) menu ──
  const appMenu = await Submenu.new({
    text: "Plexify",
    items: [
      await PredefinedMenuItem.new({ item: { About: { name: "Plexify" } } }),
      await sep(),
      await MenuItem.new({
        id: "settings",
        text: "Settings\u2026",
        accelerator: "CmdOrCtrl+,",
        action: onSettings,
      }),
      await sep(),
      await PredefinedMenuItem.new({ item: "Services" }),
      await sep(),
      await PredefinedMenuItem.new({ item: "Hide" }),
      await PredefinedMenuItem.new({ item: "HideOthers" }),
      await PredefinedMenuItem.new({ item: "ShowAll" }),
      await sep(),
      await PredefinedMenuItem.new({ item: "Quit" }),
    ],
  })

  // ── Edit menu ──
  const editMenu = await Submenu.new({
    text: "Edit",
    items: [
      await PredefinedMenuItem.new({ item: "Undo" }),
      await PredefinedMenuItem.new({ item: "Redo" }),
      await sep(),
      await PredefinedMenuItem.new({ item: "Cut" }),
      await PredefinedMenuItem.new({ item: "Copy" }),
      await PredefinedMenuItem.new({ item: "Paste" }),
      await PredefinedMenuItem.new({ item: "SelectAll" }),
    ],
  })

  // ── Window menu ──
  const windowMenu = await Submenu.new({
    text: "Window",
    items: [
      await PredefinedMenuItem.new({ item: "Minimize" }),
      await PredefinedMenuItem.new({ item: "Maximize" }),
      await PredefinedMenuItem.new({ item: "Fullscreen" }),
      await sep(),
      await PredefinedMenuItem.new({ item: "CloseWindow" }),
    ],
  })
  await windowMenu.setAsWindowsMenuForNSApp()

  const menu = await Menu.new({ items: [appMenu, editMenu, windowMenu] })
  await menu.setAsAppMenu()
}
