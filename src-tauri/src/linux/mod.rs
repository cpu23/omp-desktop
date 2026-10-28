mod bootstrap;
mod drop;
mod notifications;
mod policy;

use std::cell::{Cell, RefCell};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};
use std::thread;

use futures_channel::oneshot;
use gtk4::gdk;
use gtk4::gio;
use gtk4::glib;
use gtk4::prelude::*;
use gtk4::{Application, ApplicationWindow, Box as GtkBox, EventControllerKey, Label, Orientation, Overlay, PropagationPhase};
use webkit6::javascriptcore::Value as JsValue;
use webkit6::prelude::*;
use webkit6::{
    ApplicationInfo, ClipboardPermissionRequest, LoadEvent, NavigationPolicyDecision,
    NotificationPermissionRequest, PolicyDecisionType, ResponsePolicyDecision,
    SecurityOrigin, Settings, UserContentInjectedFrames, UserContentManager, UserScript,
    UserScriptInjectionTime, WebContext, WebView, NetworkSession,
};

use crate::daemon;

const APP_ID: &str = "sh.omp.desktop";
const AUTOMATION_APP_ID: &str = "sh.omp.desktop.automation";
const WINDOW_TITLE: &str = "OMP Desktop";
const SHELL_MARKER: &str = "Object.defineProperty(window,'__OMP_DESKTOP_SHELL__',{value:'gtk'});";
const CONNECT_HANDLER: &str = "ompDesktopConnect";
const BOOTSTRAP_RECOVERY_MARKER: &str = "__OMP_DESKTOP_RECOVERY_ERROR__";

#[derive(Debug, Clone, PartialEq, Eq)]
struct RenderingOverrides {
    set_gdk_backend: Option<&'static str>,
    set_gsk_renderer: Option<&'static str>,
    set_force_dmabuf: Option<&'static str>,
}

fn rendering_overrides(
    gdk_backend: Option<&str>,
    gsk_renderer: Option<&str>,
    wayland_display: Option<&str>,
    session_type: Option<&str>,
    force_dmabuf: Option<&str>,
    disable_dmabuf: Option<&str>,
    force_shm: Option<&str>,
) -> RenderingOverrides {
    fn nonempty(value: Option<&str>) -> Option<&str> {
        value.filter(|value| !value.is_empty())
    }
    let explicit_backend = nonempty(gdk_backend);
    let resulting_backend = explicit_backend.or_else(|| {
        (nonempty(wayland_display).is_some() || session_type == Some("wayland")).then_some("wayland")
    });
    let set_gdk_backend = if explicit_backend.is_none() && resulting_backend == Some("wayland") {
        Some("wayland")
    } else {
        None
    };

    let set_gsk_renderer = nonempty(gsk_renderer).is_none().then_some("gl");
    let set_force_dmabuf = if nonempty(force_dmabuf).is_none()
        && resulting_backend == Some("wayland")
        && nonempty(disable_dmabuf).is_none()
        && nonempty(force_shm).is_none()
    {
        Some("1")
    } else {
        None
    };

    RenderingOverrides { set_gdk_backend, set_gsk_renderer, set_force_dmabuf }
}

fn configure_rendering_environment() {
    let overrides = rendering_overrides(
        std::env::var("GDK_BACKEND").ok().as_deref(),
        std::env::var("GSK_RENDERER").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::env::var("WEBKIT_FORCE_DMABUF_RENDERER").ok().as_deref(),
        std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").ok().as_deref(),
        std::env::var("WEBKIT_DMABUF_RENDERER_FORCE_SHM").ok().as_deref(),
    );
    if let Some(value) = overrides.set_gdk_backend {
        std::env::set_var("GDK_BACKEND", value);
    }
    if let Some(value) = overrides.set_gsk_renderer {
        std::env::set_var("GSK_RENDERER", value);
    }
    if let Some(value) = overrides.set_force_dmabuf {
        std::env::set_var("WEBKIT_FORCE_DMABUF_RENDERER", value);
    }
}

pub fn run() {
    configure_rendering_environment();
    glib::set_application_name("omp-desktop");

    let mut automation_mode = false;
    let args = std::env::args_os().filter_map(|argument| {
        if argument == "--automation-mode" {
            automation_mode = true;
            None
        } else {
            Some(argument)
        }
    }).collect::<Vec<OsString>>();

    let mut builder = Application::builder().application_id(if automation_mode { AUTOMATION_APP_ID } else { APP_ID });
    if automation_mode {
        builder = builder.flags(gio::ApplicationFlags::NON_UNIQUE);
    }
    let application = builder.build();
    let shell_state: Rc<RefCell<Option<ShellState>>> = Rc::new(RefCell::new(None));
    let active_window: Rc<RefCell<Option<ApplicationWindow>>> = Rc::new(RefCell::new(None));

    let notifications = notifications::new_store();
    notifications::install_click_action(&application, &notifications);
    let activation_state = shell_state.clone();
    let activation_window = active_window.clone();
    let activation_notifications = notifications.clone();
    application.connect_activate(move |app| {
        if let Some(window) = activation_window.borrow().as_ref() {
            window.unminimize();
            window.set_visible(true);
            window.present();
            return;
        }

        let port = daemon::daemon_port();
        match build_window(
            app,
            port,
            automation_mode,
            &activation_state,
            &activation_window,
            &activation_notifications,
        ) {
            Ok(state) => {
                *activation_window.borrow_mut() = Some(state.window.clone());
                *activation_state.borrow_mut() = Some(state);
            }
            Err(error) => {
                let window = show_startup_error(app, &error);
                let weak_window_slot = Rc::downgrade(&activation_window);
                window.connect_close_request(move |_| {
                    if let Some(slot) = weak_window_slot.upgrade() {
                        *slot.borrow_mut() = None;
                    }
                    glib::Propagation::Proceed
                });
                *activation_window.borrow_mut() = Some(window);
            }
        }
    });

    application.run_with_args_os(&args);
}

struct ShellState {
    window: ApplicationWindow,
    view: WebView,
    _context: WebContext,
    _network_session: NetworkSession,
    _user_content: UserContentManager,
}

fn build_window(
    application: &Application,
    port: u16,
    automation_mode: bool,
    shell_state: &Rc<RefCell<Option<ShellState>>>,
    active_window: &Rc<RefCell<Option<ApplicationWindow>>>,
    notifications: &notifications::NotificationStore,
) -> Result<ShellState, String> {
    let (data_dir, cache_dir) = profile_directories()?;
    prepare_profile_directory(&data_dir)?;
    prepare_profile_directory(&cache_dir)?;

    // Create the persistent network profile and register every WebKit boundary
    // before the first web process can be started.
    let data_dir_string = data_dir.to_str().ok_or_else(|| "The WebKit data profile path is not valid UTF-8".to_owned())?;
    let cache_dir_string = cache_dir.to_str().ok_or_else(|| "The WebKit cache profile path is not valid UTF-8".to_owned())?;
    let network_session = NetworkSession::new(Some(data_dir_string), Some(cache_dir_string));
    let context = WebContext::new();
    bootstrap::register(&context);
    let daemon_origin = SecurityOrigin::new("http", "127.0.0.1", port);
    let permission_origin_for_process = daemon_origin.clone();
    context.connect_initialize_notification_permissions(move |context| {
        context.initialize_notification_permissions(&[&permission_origin_for_process], &[]);
    });
    context.initialize_notification_permissions(&[&daemon_origin], &[]);
    if automation_mode {
        context.set_automation_allowed(true);
    }

    let user_content = UserContentManager::new();
    let daemon_script_allow = "http://127.0.0.1/*";
    let daemon_script_origin = if port == 80 {
        "http://127.0.0.1".to_owned()
    } else {
        format!("http://127.0.0.1:{port}")
    };
    let daemon_script_origin = serde_json::to_string(&daemon_script_origin)
        .expect("daemon origin is always a valid JSON string");
    let user_script_source =
        format!("if(location.origin==={daemon_script_origin}){{{SHELL_MARKER}}}");
    let user_script = UserScript::new(
        &user_script_source,
        UserContentInjectedFrames::TopFrame,
        UserScriptInjectionTime::Start,
        &[daemon_script_allow],
        &[],
    );
    user_content.add_script(&user_script);

    let settings = Settings::new();
    settings.set_javascript_can_access_clipboard(true);
    let mut view_builder = WebView::builder()
        .web_context(&context)
        .network_session(&network_session)
        .user_content_manager(&user_content)
        .settings(&settings)
        .zoom_level(1.0);
    if automation_mode {
        view_builder = view_builder.is_controlled_by_automation(true);
    }
    let view = view_builder.build();
    view.set_hexpand(true);
    view.set_vexpand(true);
    disable_zoom_shortcuts(&view);
    drop::attach(&view);

    notifications::attach_to_view(application, &view, notifications);

    let window = ApplicationWindow::builder()
        .application(application)
        .title(WINDOW_TITLE)
        .default_width(1280)
        .default_height(800)
        .resizable(true)
        .build();
    window.set_icon_name(Some(APP_ID));
    window.set_size_request(800, 520);

    let overlay = Overlay::new();
    overlay.set_child(Some(&view));
    let error_box = GtkBox::new(Orientation::Vertical, 12);
    error_box.set_halign(gtk4::Align::Center);
    error_box.set_valign(gtk4::Align::Center);
    error_box.set_margin_start(24);
    error_box.set_margin_end(24);
    error_box.set_margin_top(24);
    error_box.set_margin_bottom(24);
    let error_label = Label::new(None);
    error_label.set_wrap(true);
    error_label.set_selectable(true);
    error_label.set_max_width_chars(72);
    let retry_button = gtk4::Button::with_label("Retry");
    error_box.append(&error_label);
    error_box.append(&retry_button);
    error_box.set_visible(false);
    overlay.add_overlay(&error_box);
    window.set_child(Some(&overlay));

    let permission_port = port;
    view.connect_permission_request(move |view, request| {
        let uri = view.uri().unwrap_or_default();
        let kind = if request.downcast_ref::<ClipboardPermissionRequest>().is_some() {
            policy::PermissionKind::Clipboard
        } else if request.downcast_ref::<NotificationPermissionRequest>().is_some() {
            policy::PermissionKind::Notification
        } else {
            policy::PermissionKind::Other
        };
        if policy::permission_allowed(uri.as_str(), permission_port, kind) {
            request.allow();
        } else {
            request.deny();
        }
        true
    });
    let bootstrap_generation = Rc::new(Cell::new(0u64));
    install_navigation_policy(&view, port, &user_content, &bootstrap_generation);
    let single_flight = Rc::new(Cell::new(false));
    install_connect_bridge(&view, &user_content, port, &single_flight, &bootstrap_generation);

    let recovery_script: Rc<RefCell<Option<UserScript>>> = Rc::new(RefCell::new(None));
    let recovery_in_progress = Rc::new(Cell::new(false));
    let retry_view = view.downgrade();
    let retry_manager = user_content.clone();
    let retry_recovery_script = recovery_script.clone();
    let retry_recovery_in_progress = recovery_in_progress.clone();
    let retry_error = error_label.clone();
    let retry_overlay = error_box.clone();
    let retry_generation = Rc::clone(&bootstrap_generation);
    retry_button.connect_clicked(move |_| {
        let message = retry_error.text().to_string();
        if let Some(view) = retry_view.upgrade() {
            begin_bootstrap_recovery(
                &view,
                &retry_manager,
                &retry_recovery_script,
                &retry_recovery_in_progress,
                &retry_generation,
                &retry_overlay,
                &retry_error,
                &message,
            );
        }
    });

    let finished_recovery_script = recovery_script.clone();
    let finished_recovery = recovery_in_progress.clone();
    let finished_error_box = error_box.clone();
    let finished_manager = user_content.clone();
    let finished_app = application.clone();
    let finished_notifications = Rc::clone(notifications);
    view.connect_load_changed(move |view, event| {
        if event == LoadEvent::Started {
            notifications::withdraw_all(&finished_app, &finished_notifications);
        }
        if event == LoadEvent::Finished && view.uri().as_deref() == Some(policy::BOOTSTRAP_URI) {
            if let Some(script) = finished_recovery_script.borrow_mut().take() {
                finished_manager.remove_script(&script);
            }
            finished_recovery.set(false);
            finished_error_box.set_visible(false);
        }
    });

    let failure_view = view.downgrade();
    let failure_manager = user_content.clone();
    let failure_script = recovery_script.clone();
    let failure_in_progress = recovery_in_progress.clone();
    let failure_generation = Rc::clone(&bootstrap_generation);
    let failure_overlay = error_box.clone();
    let failure_label = error_label.clone();
    let failure_app = application.clone();
    let failure_notifications = Rc::clone(notifications);
    view.connect_load_failed(move |_view, _event, failing_uri, error| {
        notifications::withdraw_all(&failure_app, &failure_notifications);
        let message = format!("Could not load {failing_uri}: {}", error.message());
        failure_label.set_text(&message);
        failure_overlay.set_visible(true);
        if !failure_in_progress.get() {
            if let Some(view) = failure_view.upgrade() {
                begin_bootstrap_recovery(
                    &view,
                    &failure_manager,
                    &failure_script,
                    &failure_in_progress,
                    &failure_generation,
                    &failure_overlay,
                    &failure_label,
                    &message,
                );
            }
        } else {
            failure_in_progress.set(false);
            if let Some(script) = failure_script.borrow_mut().take() {
                failure_manager.remove_script(&script);
            }
        }
        true
    });

    let terminated_view = view.downgrade();
    let terminated_manager = user_content.clone();
    let terminated_script = recovery_script.clone();
    let terminated_recovery = recovery_in_progress.clone();
    let terminated_generation = Rc::clone(&bootstrap_generation);
    let terminated_overlay = error_box.clone();
    let terminated_label = error_label.clone();
    let terminated_app = application.clone();
    let terminated_notifications = Rc::clone(notifications);
    view.connect_web_process_terminated(move |_view, reason| {
        notifications::withdraw_all(&terminated_app, &terminated_notifications);
        let message = format!("The WebKit content process stopped unexpectedly ({reason:?}). Retry to reconnect.");
        terminated_label.set_text(&message);
        terminated_overlay.set_visible(true);
        if !terminated_recovery.get() {
            if let Some(view) = terminated_view.upgrade() {
                begin_bootstrap_recovery(
                    &view,
                    &terminated_manager,
                    &terminated_script,
                    &terminated_recovery,
                    &terminated_generation,
                    &terminated_overlay,
                    &terminated_label,
                    &message,
                );
            }
        }
    });

    let close_state = Rc::downgrade(shell_state);
    let close_window_slot = Rc::downgrade(active_window);
    let close_notifications = Rc::clone(notifications);
    let close_app = application.clone();
    window.connect_close_request(move |_| {
        notifications::withdraw_all(&close_app, &close_notifications);
        if let Some(state) = close_state.upgrade() {
            *state.borrow_mut() = None;
        }
        if let Some(slot) = close_window_slot.upgrade() {
            *slot.borrow_mut() = None;
        }
        glib::Propagation::Proceed
    });
    // WebDriver closes the browsing context through WebKit's close signal.
    // The embedder owns the view, so close its GTK toplevel as well.
    let close_window = window.downgrade();
    view.connect_close(move |_| {
        if let Some(window) = close_window.upgrade() {
            window.close();
        }
    });

    if automation_mode {
        install_automation(&context, shell_state);
    }

    window.present();
    view.load_uri(policy::BOOTSTRAP_URI);
    Ok(ShellState {
        window,
        view,
        _context: context,
        _network_session: network_session,
        _user_content: user_content,
    })
}

fn profile_directories() -> Result<(PathBuf, PathBuf), String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "HOME must be an absolute path to create the WebKit profile".to_owned())?;
    let data_home = xdg_absolute("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local/share"));
    let cache_home = xdg_absolute("XDG_CACHE_HOME").unwrap_or_else(|| home.join(".cache"));
    Ok((data_home.join(APP_ID), cache_home.join(APP_ID)))
}

fn xdg_absolute(variable: &str) -> Option<PathBuf> {
    let path = std::env::var_os(variable).map(PathBuf::from)?;
    path.is_absolute().then_some(path)
}

fn prepare_profile_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("Could not create WebKit profile directory {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not secure WebKit profile directory {}: {error}", path.display()))?;
    }
    Ok(())
}

fn install_navigation_policy(
    view: &WebView,
    port: u16,
    user_content: &UserContentManager,
    bootstrap_generation: &Rc<Cell<u64>>,
) {
    let manager = user_content.clone();
    let generation = Rc::clone(bootstrap_generation);
    let weak_view = view.downgrade();
    view.connect_decide_policy(move |_view, decision, decision_type| {
        if decision_type == PolicyDecisionType::NewWindowAction {
            let uri = decision
                .downcast_ref::<NavigationPolicyDecision>()
                .and_then(|navigation| navigation.navigation_action())
                .and_then(|action| action.request())
                .and_then(|request| request.uri())
                .map(|uri| uri.to_string());
            decision.ignore();
            if let Some(uri) = uri {
                match policy::classify_navigation(&uri, port) {
                    policy::NavigationDecision::Allow => {
                        if uri == policy::BOOTSTRAP_URI {
                            generation.set(generation.get().wrapping_add(1));
                            ensure_connect_handler(&manager);
                        } else {
                            manager.unregister_script_message_handler(CONNECT_HANDLER, None);
                        }
                        if let Some(view) = weak_view.upgrade() {
                            view.load_uri(&uri);
                        }
                    }
                    policy::NavigationDecision::OpenExternal(url) => daemon::open_in_browser(&url),
                    policy::NavigationDecision::Deny => {}
                }
            }
            return true;
        }

        let uri = match decision_type {
            PolicyDecisionType::NavigationAction => decision
                .downcast_ref::<NavigationPolicyDecision>()
                .and_then(|navigation| navigation.navigation_action())
                .and_then(|action| action.request())
                .and_then(|request| request.uri()),
            PolicyDecisionType::Response => decision
                .downcast_ref::<ResponsePolicyDecision>()
                .and_then(|response| response.response())
                .and_then(|response| response.uri()),
            _ => None,
        };
        let Some(uri) = uri else {
            decision.ignore();
            return true;
        };

        match policy::classify_navigation(uri.as_str(), port) {
            policy::NavigationDecision::Allow => {
                if uri.as_str() == policy::BOOTSTRAP_URI {
                    generation.set(generation.get().wrapping_add(1));
                    ensure_connect_handler(&manager);
                } else {
                    manager.unregister_script_message_handler(CONNECT_HANDLER, None);
                }
                decision.use_();
            }
            policy::NavigationDecision::OpenExternal(url) => {
                daemon::open_in_browser(&url);
                decision.ignore();
            }
            policy::NavigationDecision::Deny => decision.ignore(),
        }
        true
    });
    view.connect_create(|_view, _action| None);
}

fn install_connect_bridge(
    view: &WebView,
    user_content: &UserContentManager,
    port: u16,
    single_flight: &Rc<Cell<bool>>,
    bootstrap_generation: &Rc<Cell<u64>>,
) {
    let weak_view = view.downgrade();
    let flight = Rc::clone(single_flight);
    let generation = Rc::clone(bootstrap_generation);
    let manager = user_content.clone();
    let signal_manager = manager.clone();
    signal_manager.connect_script_message_with_reply_received(
        Some(CONNECT_HANDLER),
        move |_manager, value, reply| {
            let Some(view) = weak_view.upgrade() else {
                reply.return_error_message("The desktop window has closed.");
                return true;
            };
            if view.uri().as_deref() != Some(policy::BOOTSTRAP_URI) {
                reply.return_error_message("The desktop connection handler is available only on the connection page.");
                return true;
            }
            if !value.is_string() || value.to_str().as_str() != "connect" {
                reply.return_error_message("Unsupported desktop connection request.");
                return true;
            }
            let Some(js_context) = value.context() else {
                reply.return_error_message("The WebKit connection reply context is unavailable.");
                return true;
            };
            let request_generation = generation.get();
            if flight.replace(true) {
                reply.return_error_message("A daemon connection is already in progress.");
                return true;
            }

            let (sender, receiver) = oneshot::channel::<Result<String, String>>();
            thread::spawn(move || {
                let _ = sender.send(daemon::connect_blocking(port));
            });
            let weak_view = weak_view.clone();
            let flight = Rc::clone(&flight);
            let completion_generation = Rc::clone(&generation);
            let manager = manager.clone();
            let reply = reply.clone();
            glib::spawn_future_local(async move {
                let result = receiver.await;
                let Some(view) = weak_view.upgrade() else { return };
                if completion_generation.get() != request_generation {
                    flight.set(false);
                    return;
                }
                if view.uri().as_deref() != Some(policy::BOOTSTRAP_URI) {
                    flight.set(false);
                    reply.return_error_message("The connection page changed before the daemon connection completed.");
                    return;
                }
                match result {
                    Ok(Ok(build)) => {
                        flight.set(false);
                        let value = JsValue::new_string(&js_context, Some(&build));
                        reply.return_value(&value);
                        manager.unregister_script_message_handler(CONNECT_HANDLER, None);
                        glib::idle_add_local_once(move || {
                            if let Some(view) = weak_view.upgrade() {
                                view.load_uri(crate::daemon::daemon_url(port).as_str());
                            }
                        });
                    }
                    Ok(Err(error)) => {
                        flight.set(false);
                        reply.return_error_message(&error);
                    }
                    Err(_) => {
                        flight.set(false);
                        reply.return_error_message("The daemon connection worker ended unexpectedly.");
                    }
                }
            });
            true
        },
    );
}


fn ensure_connect_handler(user_content: &UserContentManager) {
    let _ = user_content.register_script_message_handler_with_reply(CONNECT_HANDLER, None);
}

fn begin_bootstrap_recovery(
    view: &WebView,
    user_content: &UserContentManager,
    recovery_script: &Rc<RefCell<Option<UserScript>>>,
    recovery_in_progress: &Rc<Cell<bool>>,
    bootstrap_generation: &Rc<Cell<u64>>,
    overlay: &GtkBox,
    error_label: &Label,
    message: &str,
) {
    if recovery_in_progress.replace(true) {
        return;
    }
    bootstrap_generation.set(bootstrap_generation.get().wrapping_add(1));
    if let Some(script) = recovery_script.borrow_mut().take() {
        user_content.remove_script(&script);
    }
    error_label.set_text(message);
    overlay.set_visible(true);
    let escaped = serde_json::to_string(message).unwrap_or_else(|_| "\"The WebKit page failed. Retry to reconnect.\"".to_owned());
    let source = format!(
        "Object.defineProperty(window,{marker},{{value:{escaped}}});",
        marker = serde_json::to_string(BOOTSTRAP_RECOVERY_MARKER).expect("marker is valid JSON"),
    );
    let script = UserScript::new(
        &source,
        UserContentInjectedFrames::TopFrame,
        UserScriptInjectionTime::Start,
        &["omp://bootstrap/*"],
        &[],
    );
    user_content.add_script(&script);
    *recovery_script.borrow_mut() = Some(script);
    view.load_uri(policy::BOOTSTRAP_URI);
}

fn disable_zoom_shortcuts(view: &WebView) {
    let controller = EventControllerKey::new();
    controller.set_propagation_phase(PropagationPhase::Capture);
    controller.connect_key_pressed(|_, key, _, modifiers| {
        if modifiers.contains(gdk::ModifierType::CONTROL_MASK)
            && key.to_unicode().is_some_and(|character| matches!(character, '+' | '-' | '=' | '0'))
        {
            glib::Propagation::Stop
        } else {
            glib::Propagation::Proceed
        }
    });
    view.add_controller(controller);
}

fn install_automation(context: &WebContext, shell_state: &Rc<RefCell<Option<ShellState>>>) {
    let weak_state = Rc::downgrade(shell_state);
    context.connect_automation_started(move |_context, session| {
        let info = ApplicationInfo::new();
        info.set_name("omp-desktop");
        info.set_version(1, 0, 0);
        session.set_application_info(&info);
        let weak_state: Weak<RefCell<Option<ShellState>>> = weak_state.clone();
        session.connect_create_web_view(None, move |_session| {
            let state = weak_state.upgrade().expect("automation window state exists");
            let state = state.borrow();
            let state = state.as_ref().expect("automation view is created with the application window");
            state.window.present();
            state.view.clone()
        });
    });
}

fn show_startup_error(application: &Application, message: &str) -> ApplicationWindow {
    let window = ApplicationWindow::builder()
        .application(application)
        .title(WINDOW_TITLE)
        .default_width(800)
        .default_height(520)
        .resizable(true)
        .build();
    window.set_icon_name(Some(APP_ID));
    window.set_size_request(800, 520);
    let box_widget = GtkBox::new(Orientation::Vertical, 12);
    box_widget.set_halign(gtk4::Align::Center);
    box_widget.set_valign(gtk4::Align::Center);
    box_widget.set_margin_start(24);
    box_widget.set_margin_end(24);
    let label = Label::new(Some(message));
    label.set_wrap(true);
    label.set_selectable(true);
    box_widget.append(&label);
    window.set_child(Some(&box_widget));
    window.present();
    window
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendering_defaults_follow_only_the_selected_wayland_backend() {
        assert_eq!(
            rendering_overrides(None, None, Some("wayland-0"), Some("wayland"), None, None, None),
            RenderingOverrides {
                set_gdk_backend: Some("wayland"),
                set_gsk_renderer: Some("gl"),
                set_force_dmabuf: Some("1"),
            }
        );
        assert_eq!(
            rendering_overrides(Some("x11"), None, Some("wayland-0"), Some("wayland"), None, None, None),
            RenderingOverrides { set_gdk_backend: None, set_gsk_renderer: Some("gl"), set_force_dmabuf: None }
        );
        assert_eq!(
            rendering_overrides(Some("wayland,x11"), None, None, None, None, None, None),
            RenderingOverrides { set_gdk_backend: None, set_gsk_renderer: Some("gl"), set_force_dmabuf: None }
        );
    }

    #[test]
    fn rendering_defaults_respect_explicit_values_and_dmabuf_disablers() {
        for (force, disable, force_shm) in [
            (Some("0"), None, None),
            (None, Some("1"), None),
            (None, None, Some("1")),
        ] {
            assert_eq!(
                rendering_overrides(Some("wayland"), Some("vulkan"), None, None, force, disable, force_shm),
                RenderingOverrides { set_gdk_backend: None, set_gsk_renderer: None, set_force_dmabuf: None }
            );
        }
        assert_eq!(
            rendering_overrides(Some(""), Some(""), Some(""), Some("wayland"), Some(""), Some(""), Some("")),
            RenderingOverrides {
                set_gdk_backend: Some("wayland"),
                set_gsk_renderer: Some("gl"),
                set_force_dmabuf: Some("1"),
            }
        );
        assert_eq!(
            rendering_overrides(None, None, None, Some("x11"), None, None, None),
            RenderingOverrides { set_gdk_backend: None, set_gsk_renderer: Some("gl"), set_force_dmabuf: None }
        );
    }

    #[test]
    fn profile_xdg_overrides_must_be_absolute() {
        assert_eq!(xdg_absolute_from(Some("relative")), None);
        assert_eq!(xdg_absolute_from(Some("/tmp/profile")), Some(PathBuf::from("/tmp/profile")));
    }

    fn xdg_absolute_from(value: Option<&str>) -> Option<PathBuf> {
        value.map(PathBuf::from).filter(|path| path.is_absolute())
    }
}
