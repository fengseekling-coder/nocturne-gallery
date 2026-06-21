//! macOS / 桌面端原生菜单栏（中文）

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager,
};

const MENU_PREFS: &str = "menu_preferences";
const MENU_RELOAD: &str = "menu_reload";

/// 构建应用菜单（顶层：文件 / 编辑 / 视图 / 窗口 / 帮助）
pub fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let sep = |a: &AppHandle| PredefinedMenuItem::separator(a);

    // —— 应用菜单（macOS 第一项，显示为 productName）——
    let about = PredefinedMenuItem::about(app, Some("关于 Gega Gallery"), None)?;
    let services = PredefinedMenuItem::services(app, Some("服务"))?;
    let hide = PredefinedMenuItem::hide(app, Some("隐藏 Gega Gallery"))?;
    let hide_others = PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?;
    let show_all = PredefinedMenuItem::show_all(app, Some("显示全部"))?;
    let quit = PredefinedMenuItem::quit(app, Some("退出 Gega Gallery"))?;

    let app_menu = Submenu::with_items(
        app,
        "Gega Gallery",
        true,
        &[
            &about,
            &sep(app)?,
            &services,
            &sep(app)?,
            &hide,
            &hide_others,
            &show_all,
            &sep(app)?,
            &quit,
        ],
    )?;

    // —— 文件 ——
    let prefs = MenuItem::with_id(app, MENU_PREFS, "首选项…", true, Some("CmdOrCtrl+,"))?;
    let close_win = PredefinedMenuItem::close_window(app, Some("关闭窗口"))?;
    let file_menu = Submenu::with_items(app, "文件", true, &[&prefs, &sep(app)?, &close_win])?;

    // —— 编辑 ——
    let undo = PredefinedMenuItem::undo(app, Some("撤销"))?;
    let redo = PredefinedMenuItem::redo(app, Some("重做"))?;
    let cut = PredefinedMenuItem::cut(app, Some("剪切"))?;
    let copy = PredefinedMenuItem::copy(app, Some("拷贝"))?;
    let paste = PredefinedMenuItem::paste(app, Some("粘贴"))?;
    let select_all = PredefinedMenuItem::select_all(app, Some("全选"))?;
    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &undo,
            &redo,
            &sep(app)?,
            &cut,
            &copy,
            &paste,
            &sep(app)?,
            &select_all,
        ],
    )?;

    // —— 视图 ——
    let reload = MenuItem::with_id(app, MENU_RELOAD, "重新加载", true, Some("CmdOrCtrl+R"))?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, Some("进入全屏"))?;
    let view_menu = Submenu::with_items(app, "视图", true, &[&reload, &sep(app)?, &fullscreen])?;

    // —— 窗口 ——
    let minimize = PredefinedMenuItem::minimize(app, Some("最小化"))?;
    let maximize = PredefinedMenuItem::maximize(app, Some("缩放"))?;
    let window_menu = Submenu::with_items(app, "窗口", true, &[&minimize, &maximize])?;

    // —— 帮助 ——
    let help_menu = Submenu::with_items(app, "帮助", true, &[&about])?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

/// 处理自定义菜单项点击
pub fn handle_menu_event(app: &AppHandle, event_id: &str) {
    match event_id {
        MENU_PREFS => {
            let _ = app.emit("menu-open-preferences", ());
        }
        MENU_RELOAD => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval("window.location.reload()");
            }
        }
        _ => {}
    }
}
