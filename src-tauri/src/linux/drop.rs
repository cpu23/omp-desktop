use gtk4::{gdk, prelude::*, DropTarget, PropagationPhase};
use webkit6::WebView;
use webkit6::prelude::*;

const EVENT: &str = "omp-desktop-file-drop";

pub fn attach(view: &WebView) {
    let target = DropTarget::new(gdk::FileList::static_type(), gdk::DragAction::COPY);
    target.set_propagation_phase(PropagationPhase::Capture);
    let weak_view = view.downgrade();
    target.connect_drop(move |_target, value, x, y| {
        let Ok(files) = value.get::<gdk::FileList>() else {
            return false;
        };

        let paths = files
            .files()
            .iter()
            .filter_map(|file| file.path())
            .map(|path| path.to_string_lossy().into_owned())
            .filter(|path| !path.is_empty() && !path.chars().any(char::is_control))
            .collect::<Vec<_>>();
        if !paths.is_empty() {
            if let Some(view) = weak_view.upgrade() {
                dispatch_paths(&view, &paths, x, y);
            }
        }
        // A FileList is an OS file drop even when it contains only non-local
        // URIs; consume it so WebKit cannot navigate to the dropped resource.
        true
    });
    view.add_controller(target);
}

fn dispatch_paths(view: &WebView, paths: &[String], widget_x: f64, widget_y: f64) {
    let zoom = view.zoom_level();
    let zoom = if zoom.is_finite() && zoom > 0.0 { zoom } else { 1.0 };
    let payload = serde_json::json!({
        "paths": paths,
        "x": widget_x / zoom,
        "y": widget_y / zoom,
    });
    let Ok(payload) = serde_json::to_string(&payload) else {
        return;
    };
    let script = format!(
        "window.dispatchEvent(new CustomEvent({event}, {{ detail: {payload} }}));",
        event = serde_json::to_string(EVENT).expect("event name is valid JSON"),
    );
    let _ = view.evaluate_javascript(&script, None, None, None::<&gtk4::gio::Cancellable>, |_| {});
}
