use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use gtk4::{gio, prelude::*, Application};
use webkit6::{Notification, WebView};
use webkit6::prelude::*;

pub type NotificationStore = Rc<RefCell<HashMap<u64, Notification>>>;

pub fn new_store() -> NotificationStore {
    Rc::new(RefCell::new(HashMap::new()))
}

pub fn install_click_action(app: &Application, notifications: &NotificationStore) {
    let action = gio::SimpleAction::new("notification-clicked", Some(&String::static_variant_type()));
    let notifications = Rc::clone(notifications);
    let app_for_action = app.clone();
    action.connect_activate(move |_action, target| {
        let Some(id) = target
            .and_then(|value| value.get::<String>())
            .and_then(|value| value.parse::<u64>().ok())
        else {
            return;
        };
        let Some(notification) = notifications.borrow_mut().remove(&id) else {
            return;
        };
        if let Some(window) = app_for_action.active_window() {
            window.unminimize();
            window.present();
        }
        notification.clicked();
    });
    app.add_action(&action);
}

pub fn attach_to_view(app: &Application, view: &WebView, notifications: &NotificationStore) {
    let notification_app = app.clone();
    let weak_notifications = Rc::downgrade(notifications);
    view.connect_show_notification(move |_view, notification| {
        let id = notification.id();
        let key = id.to_string();
        if let Some(old) = weak_notifications
            .upgrade()
            .and_then(|store| store.borrow_mut().remove(&id))
        {
            notification_app.withdraw_notification(&key);
            old.close();
        }

        let title = notification.title();
        let native = gio::Notification::new(title.as_deref().unwrap_or("OMP Desktop"));
        if let Some(body) = notification.body() {
            native.set_body(Some(body.as_str()));
        }
        let target = id.to_string().to_variant();
        native.set_default_action_and_target_value("app.notification-clicked", Some(&target));
        notification_app.send_notification(Some(&key), &native);

        if let Some(store) = weak_notifications.upgrade() {
            store.borrow_mut().insert(id, notification.clone());
        }

        let closed_app = notification_app.clone();
        let weak_store: Weak<RefCell<HashMap<u64, Notification>>> = weak_notifications.clone();
        let closed_key = key.clone();
        notification.connect_closed(move |closed| {
            if let Some(store) = weak_store.upgrade() {
                store.borrow_mut().remove(&closed.id());
            }
            closed_app.withdraw_notification(&closed_key);
        });
        true
    });
}

pub fn withdraw_all(app: &Application, notifications: &NotificationStore) {
    let active = notifications.borrow_mut().drain().collect::<Vec<_>>();
    for (id, notification) in active {
        app.withdraw_notification(&id.to_string());
        notification.close();
    }
}
