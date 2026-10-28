#!/usr/bin/python3
"""Deterministic private-session-bus org.freedesktop.Notifications fixture."""
import json
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

BUS_NAME = "org.freedesktop.Notifications"
OBJECT_PATH = "/org/freedesktop/Notifications"
INTERFACE = "org.freedesktop.Notifications"

XML = """
<node>
  <interface name="org.freedesktop.Notifications">
    <method name="GetCapabilities"><arg direction="out" type="as"/></method>
    <method name="Notify">
      <arg direction="in" type="s"/><arg direction="in" type="u"/>
      <arg direction="in" type="s"/><arg direction="in" type="s"/>
      <arg direction="in" type="s"/><arg direction="in" type="as"/>
      <arg direction="in" type="a{sv}"/><arg direction="in" type="i"/>
      <arg direction="out" type="u"/>
    </method>
    <method name="CloseNotification"><arg direction="in" type="u"/></method>
    <method name="GetServerInformation">
      <arg direction="out" type="s"/><arg direction="out" type="s"/>
      <arg direction="out" type="s"/><arg direction="out" type="s"/>
    </method>
    <signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
    <signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
  </interface>
</node>
"""


def emit(record):
    sys.stdout.write(json.dumps(record, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class NotificationFixture:
    def __init__(self):
        self.loop = None
        self.connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.info = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0]
        self.notifications = {}
        self.next_id = 1
        self.connection.register_object(OBJECT_PATH, self.info, self.handle_method, None, None)
        Gio.bus_own_name_on_connection(
            self.connection,
            BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            self.on_name_acquired,
            self.on_name_lost,
        )

    def on_name_acquired(self, _connection, _name):
        emit({"event": "ready", "name": BUS_NAME, "path": OBJECT_PATH})

    def on_name_lost(self, _connection, name):
        emit({"event": "name-lost", "name": name})
        if self.loop is not None:
            self.loop.quit()

    def handle_method(self, _connection, sender, _path, interface, method, parameters, invocation):
        if interface != INTERFACE:
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownInterface", interface)
            return
        if method == "GetCapabilities":
            invocation.return_value(GLib.Variant("(as)", (["actions", "body"],)))
            return
        if method == "GetServerInformation":
            invocation.return_value(GLib.Variant("(ssss)", ("OMP native smoke fixture", "OpenAI", "1.0", "1.2")))
            return
        if method == "Notify":
            app_name, replaces_id, app_icon, summary, body, actions, hints, expire_timeout = parameters.unpack()
            notification_id = int(replaces_id) if int(replaces_id) in self.notifications else self.next_id
            if notification_id == self.next_id:
                self.next_id = 1 if self.next_id >= 0xFFFFFFFF else self.next_id + 1
            record = {
                "id": notification_id,
                "app": app_name,
                "icon": app_icon,
                "title": summary,
                "body": body,
                "actions": list(actions),
                "expireTimeout": int(expire_timeout),
                "sender": sender,
                "hintKeys": sorted(hints.keys()),
            }
            self.notifications[notification_id] = record
            emit({"event": "delivery", **record})
            invocation.return_value(GLib.Variant("(u)", (notification_id,)))
            return
        if method == "CloseNotification":
            (notification_id,) = parameters.unpack()
            self.close(int(notification_id), 3)
            invocation.return_value(GLib.Variant("()", ()))
            return
        invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)

    def close(self, notification_id, reason):
        record = self.notifications.pop(notification_id, None)
        if record is None:
            return
        self.connection.emit_signal(
            None,
            OBJECT_PATH,
            INTERFACE,
            "NotificationClosed",
            GLib.Variant("(uu)", (notification_id, reason)),
        )
        emit({"event": "closed", "id": notification_id, "reason": reason})

    def activate(self, notification_id):
        record = self.notifications.get(notification_id)
        if record is None:
            emit({"event": "activation-ignored", "id": notification_id})
            return
        actions = record["actions"]
        action = actions[0] if len(actions) >= 2 else "default"
        self.connection.emit_signal(
            None,
            OBJECT_PATH,
            INTERFACE,
            "ActionInvoked",
            GLib.Variant("(us)", (notification_id, action)),
        )
        emit({"event": "activated", "id": notification_id, "action": action})

    def command(self, line):
        try:
            command = json.loads(line)
            if isinstance(command, dict) and isinstance(command.get("activate"), int):
                self.activate(command["activate"])
            elif isinstance(command, dict) and isinstance(command.get("close"), int):
                self.close(command["close"], 3)
            else:
                emit({"event": "command-error", "message": "expected {activate: id} or {close: id}"})
        except (json.JSONDecodeError, TypeError, ValueError) as error:
            emit({"event": "command-error", "message": str(error)})


def main():
    loop = GLib.MainLoop()
    fixture = NotificationFixture()
    fixture.loop = loop
    channel = GLib.IOChannel.unix_new(sys.stdin.fileno())
    GLib.io_add_watch(channel, GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, on_stdin, fixture, loop)
    loop.run()


def on_stdin(_channel, condition, fixture, loop):
    if condition & GLib.IO_IN:
        line = sys.stdin.readline()
        if line:
            fixture.command(line)
            return True
    if condition & GLib.IO_HUP:
        loop.quit()
        return False
    return True


if __name__ == "__main__":
    main()
