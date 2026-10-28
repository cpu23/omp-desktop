#!/usr/bin/env python3
"""Read bounded AT-SPI snapshots of a target application process."""

import json
import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

MAX_DEPTH = 64
MAX_NODES = 2000
MAX_DESKTOP_CHILDREN = 256
AT_SPI_TIMEOUT_MS = 1000
AT_SPI_STARTUP_TIMEOUT_MS = 5000


class SnapshotBudget:
    def __init__(self):
        self.nodes = 0
        self.truncated = False


class ApplicationNotFound(RuntimeError):
    pass


def _call_or_raise(accessible, method, *args):
    try:
        return getattr(accessible, method)(*args)
    except Exception as error:
        raise RuntimeError(f"AT-SPI {method} failed: {error}") from error


def _state_name(state):
    return str(getattr(state, "value_nick", getattr(state, "name", state)))


def _optional_extents(accessible, coordinate_type):
    try:
        rectangle = _call_or_raise(accessible, "get_extents", coordinate_type)
        if rectangle is None:
            return None
        return {
            "x": int(rectangle.x),
            "y": int(rectangle.y),
            "width": int(rectangle.width),
            "height": int(rectangle.height),
        }
    except Exception:
        return None


def _node(accessible, depth, budget):
    if budget.nodes >= MAX_NODES:
        budget.truncated = True
        return None
    budget.nodes += 1

    process_id = _call_or_raise(accessible, "get_process_id")
    name = _call_or_raise(accessible, "get_name")
    role = _call_or_raise(accessible, "get_role_name")
    state_set = _call_or_raise(accessible, "get_state_set")
    states = sorted(_state_name(state) for state in state_set.get_states())
    extents = _optional_extents(accessible, Atspi.CoordType.SCREEN)
    window_extents = _optional_extents(accessible, Atspi.CoordType.WINDOW)

    node = {
        "processid": int(process_id),
        "name": "" if name is None else str(name),
        "role": "" if role is None else str(role),
        "states": states,
        "extents": extents,
        "window_extents": window_extents,
        "children": [],
    }

    child_count = _call_or_raise(accessible, "get_child_count")
    if depth >= MAX_DEPTH:
        budget.truncated = budget.truncated or child_count > 0
        return node

    for index in range(child_count):
        if budget.nodes >= MAX_NODES:
            budget.truncated = True
            break
        child = _call_or_raise(accessible, "get_child_at_index", index)
        child_node = _node(child, depth + 1, budget)
        if child_node is not None:
            node["children"].append(child_node)
    return node


def snapshot(pid):
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        raise ValueError("pid must be a positive integer")

    desktop = Atspi.get_desktop(0)
    child_count = _call_or_raise(desktop, "get_child_count")
    roots = []
    for index in range(min(child_count, MAX_DESKTOP_CHILDREN)):
        child = _call_or_raise(desktop, "get_child_at_index", index)
        if _call_or_raise(child, "get_process_id") == pid:
            roots.append(child)
    if child_count > MAX_DESKTOP_CHILDREN:
        raise RuntimeError("AT-SPI desktop application count exceeded the snapshot bound")
    if not roots:
        raise ApplicationNotFound(
            f"No AT-SPI application was found for PID {pid}; check GTK accessibility and the AT-SPI bus"
        )

    application_roots = [
        root
        for root in roots
        if str(_call_or_raise(root, "get_role_name")).lower() == "application"
    ]
    root = application_roots[0] if application_roots else roots[0]
    budget = SnapshotBudget()
    tree = _node(root, 0, budget)
    if tree is None:
        raise RuntimeError("AT-SPI returned an empty application tree")
    tree["truncated"] = budget.truncated
    return tree


def _respond(request, *, tree=None, error=None, code=None):
    response = {"id": request.get("id"), "ok": error is None}
    if error is None:
        response["tree"] = tree
    else:
        response["error"] = str(error)
        if code is not None:
            response["code"] = code
    sys.stdout.write(json.dumps(response, separators=(",", ":"), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    Atspi.set_timeout(AT_SPI_TIMEOUT_MS, AT_SPI_STARTUP_TIMEOUT_MS)
    init_status = Atspi.init()
    if init_status != 0 or not Atspi.is_initialized():
        raise RuntimeError(f"AT-SPI initialization failed with status {init_status}")

    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be a JSON object")
            if request.get("op") != "snapshot":
                raise ValueError("op must be 'snapshot'")
            _respond(request, tree=snapshot(request.get("pid")))
        except Exception as error:
            request_id = request.get("id") if isinstance(request, dict) else None
            code = "process-not-found" if isinstance(error, ApplicationNotFound) else None
            _respond({"id": request_id}, error=error, code=code)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"accessibility helper startup failed: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
