//! Preserve a plugin's native hooks while confining its startup JS to Hibiki.
use serde_json::Value;
use tauri::{
    ipc::Invoke, plugin::Plugin, webview::PageLoadPayload, AppHandle, RunEvent, Runtime, Webview,
    Window,
};

pub(crate) struct MainWindowPlugin<P>(P);

pub(crate) fn app_only<P>(plugin: P) -> MainWindowPlugin<P> {
    MainWindowPlugin(plugin)
}

impl<R: Runtime, P: Plugin<R>> Plugin<R> for MainWindowPlugin<P> {
    fn name(&self) -> &'static str {
        self.0.name()
    }

    fn initialize(
        &mut self,
        app: &AppHandle<R>,
        config: Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.0.initialize(app, config)
    }

    fn initialization_script(&self) -> Option<String> {
        self.0.initialization_script().map(|script| {
            include_str!("main_window_plugin.js").replacen("__HIBIKI_PLUGIN_SCRIPT__", &script, 1)
        })
    }

    fn window_created(&mut self, window: Window<R>) {
        self.0.window_created(window);
    }

    fn webview_created(&mut self, webview: Webview<R>) {
        self.0.webview_created(webview);
    }

    fn on_navigation(&mut self, webview: &Webview<R>, url: &url::Url) -> bool {
        self.0.on_navigation(webview, url)
    }

    fn on_page_load(&mut self, webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
        self.0.on_page_load(webview, payload);
    }

    fn on_event(&mut self, app: &AppHandle<R>, event: &RunEvent) {
        self.0.on_event(app, event);
    }

    fn extend_api(&mut self, invoke: Invoke<R>) -> bool {
        self.0.extend_api(invoke)
    }
}
