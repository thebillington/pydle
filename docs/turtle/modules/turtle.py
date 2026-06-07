import math
from js import OffscreenCanvas
from pyodide.ffi import create_proxy


def _normalize_color(c):
    if isinstance(c, str):
        return c.replace(" ", "")
    return c

_canvas = None
_ctx = None
_canvas_width = 800
_canvas_height = 700
_bgcolor = "white"
_screen_instance = None
_tracer_mode = True

_keydown_handlers = {}
_keyup_handlers = {}
_click_handlers = []

_anim_queue = []
_anim_mode = False

_SPEED_TABLE = {
    0: 0,
    1: 2,
    2: 3,
    3: 5,
    4: 7,
    5: 9,
    6: 12,
    7: 15,
    8: 20,
    9: 25,
    10: 50,
}


def _init(width, height):
    global _canvas, _ctx, _canvas_width, _canvas_height
    _canvas = OffscreenCanvas.new(width, height)
    _ctx = _canvas.getContext("2d")
    _canvas_width = width
    _canvas_height = height
    _clear_screen()
    _flush()


def _flush():
    global _canvas, _ctx
    if _ctx:
        from js import self as js_self
        width = int(_canvas_width)
        height = int(_canvas_height)
        saved = _ctx.getImageData(0, 0, width, height)
        _draw_cursor(_get_default_turtle())
        image_data = _ctx.getImageData(0, 0, width, height)
        js_self.sendFrame(image_data)
        _ctx.putImageData(saved, 0, 0)


def _resize(width, height):
    global _canvas_width, _canvas_height
    _canvas_width = width
    _canvas_height = height


def _clear_screen():
    if _ctx:
        _ctx.fillStyle = _normalize_color(_bgcolor)
        _ctx.fillRect(0, 0, _canvas_width, _canvas_height)


def _tcx(x):
    return x + _canvas_width / 2


def _tcy(y):
    return _canvas_height / 2 - y


def _draw_cursor(t):
    if not t._visible or not _ctx:
        return
    size = 8
    rad = math.radians(t._heading)
    x1 = _tcx(t._x + size * math.cos(rad))
    y1 = _tcy(t._y + size * math.sin(rad))
    x2 = _tcx(t._x + size * math.cos(rad + 2.5))
    y2 = _tcy(t._y + size * math.sin(rad + 2.5))
    x3 = _tcx(t._x + size * math.cos(rad - 2.5))
    y3 = _tcy(t._y + size * math.sin(rad - 2.5))
    _ctx.beginPath()
    _ctx.moveTo(x1, y1)
    _ctx.lineTo(x2, y2)
    _ctx.lineTo(x3, y3)
    _ctx.closePath()
    _ctx.fillStyle = _normalize_color(t._pen_color)
    _ctx.fill()


def _handle_keydown(key):
    if key in _keydown_handlers:
        for handler in _keydown_handlers[key]:
            handler()


def _handle_keyup(key):
    if key in _keyup_handlers:
        for handler in _keyup_handlers[key]:
            handler()


def _handle_click(canvas_x, canvas_y, button):
    turtle_x = canvas_x - _canvas_width / 2
    turtle_y = _canvas_height / 2 - canvas_y
    for handler in _click_handlers:
        handler(turtle_x, turtle_y)


def _start_anim():
    global _anim_mode, _anim_queue
    _anim_mode = True
    _anim_queue = []
    t = _get_default_turtle()
    t._x = 0.0
    t._y = 0.0
    t._heading = 0.0
    t._pen_down = True
    t._pen_color = "black"
    t._fill_color = "black"
    t._filling = False
    t._fill_points = []
    t._visible = True
    if _ctx:
        _clear_screen()
        _flush()


def _stop_anim():
    global _anim_mode
    _anim_mode = False


def _reset():
    global _anim_queue, _anim_mode, _default_turtle, _tracer_mode
    _anim_mode = False
    _anim_queue = []
    _tracer_mode = True
    t = _get_default_turtle()
    t._x = 0.0
    t._y = 0.0
    t._heading = 0.0
    t._pen_down = True
    t._pen_color = "black"
    t._fill_color = "black"
    t._filling = False
    t._fill_points = []
    t._visible = True
    t._speed = 3
    if _ctx:
        _clear_screen()
        _flush()


def _anim_step():
    global _anim_queue
    if not _anim_queue:
        return False
    t = _get_default_turtle()
    cmd = _anim_queue.pop(0)
    if cmd[0] == 'line':
        _, from_x, from_y, to_x, to_y, pen_down, pen_color = cmd
        if pen_down and _ctx:
            _ctx.beginPath()
            _ctx.moveTo(_tcx(from_x), _tcy(from_y))
            _ctx.lineTo(_tcx(to_x), _tcy(to_y))
            _ctx.strokeStyle = _normalize_color(pen_color)
            _ctx.lineWidth = 1
            _ctx.stroke()
        t._x = to_x
        t._y = to_y
        if t._filling:
            t._fill_points.append((t._x, t._y))
    elif cmd[0] == 'rotate':
        _, heading = cmd
        t._heading = heading
    elif cmd[0] == 'penup':
        t._pen_down = False
    elif cmd[0] == 'pendown':
        t._pen_down = True
    elif cmd[0] == 'pencolor':
        _, color = cmd
        t._pen_color = color
    elif cmd[0] == 'fillcolor':
        _, color = cmd
        t._fill_color = color
    elif cmd[0] == 'begin_fill':
        t._filling = True
        t._fill_points = [(t._x, t._y)]
    elif cmd[0] == 'end_fill':
        if t._filling and _ctx and len(t._fill_points) >= 3:
            _ctx.beginPath()
            _ctx.moveTo(_tcx(t._fill_points[0][0]), _tcy(t._fill_points[0][1]))
            for px, py in t._fill_points[1:]:
                _ctx.lineTo(_tcx(px), _tcy(py))
            _ctx.closePath()
            _ctx.fillStyle = _normalize_color(t._fill_color)
            _ctx.fill()
        t._filling = False
        t._fill_points = []
    elif cmd[0] == 'circle':
        _, radius, pen_down, pen_color, filling, fill_color = cmd
        if not _ctx:
            _flush()
            return bool(_anim_queue)
        cx = _tcx(t._x)
        cy = _tcy(t._y) - radius
        r = abs(radius)
        if pen_down:
            _ctx.beginPath()
            _ctx.arc(cx, cy, r, 0, 2 * math.pi)
            _ctx.strokeStyle = _normalize_color(pen_color)
            _ctx.stroke()
        if filling:
            _ctx.beginPath()
            _ctx.arc(cx, cy, r, 0, 2 * math.pi)
            _ctx.fillStyle = _normalize_color(fill_color)
            _ctx.fill()
    elif cmd[0] == 'dot':
        _, tx, ty, r, color = cmd
        if _ctx:
            _ctx.beginPath()
            _ctx.arc(_tcx(tx), _tcy(ty), r, 0, 2 * math.pi)
            _ctx.fillStyle = _normalize_color(color)
            _ctx.fill()
    elif cmd[0] == 'write':
        _, tx, ty, text, pen_color, family, size, align = cmd
        if _ctx:
            _ctx.font = f"{size}px {family}"
            _ctx.fillStyle = _normalize_color(pen_color)
            _ctx.textBaseline = "middle"
            _ctx.textAlign = align
            _ctx.fillText(str(text), _tcx(tx), _tcy(ty))
    elif cmd[0] == 'hideturtle':
        t._visible = False
    elif cmd[0] == 'showturtle':
        t._visible = True
    elif cmd[0] == 'setheading':
        _, heading = cmd
        t._heading = heading
    _flush()
    return bool(_anim_queue)


def _has_anim():
    return bool(_anim_queue)


def _anim_len():
    return len(_anim_queue)


class Turtle:
    def __init__(self):
        self._x = 0.0
        self._y = 0.0
        self._heading = 0.0
        self._pen_down = True
        self._pen_color = "black"
        self._fill_color = "black"
        self._filling = False
        self._fill_points = []
        self._visible = True
        self._speed = 3

    def penup(self):
        self._pen_down = False
        if _anim_mode:
            _anim_queue.append(('penup',))
        elif _tracer_mode:
            _flush()

    def pendown(self):
        self._pen_down = True
        if _anim_mode:
            _anim_queue.append(('pendown',))
        elif _tracer_mode:
            _flush()

    def isdown(self):
        return self._pen_down

    def goto(self, x, y=None):
        if y is None:
            x, y = x
        if _anim_mode:
            old_x, old_y = self._x, self._y
            self._x = float(x)
            self._y = float(y)
            if self._filling:
                self._fill_points.append((self._x, self._y))
            _anim_queue.append(('line', old_x, old_y, self._x, self._y, self._pen_down, self._pen_color))
        else:
            if _ctx and self._pen_down:
                _ctx.beginPath()
                _ctx.moveTo(_tcx(self._x), _tcy(self._y))
                _ctx.lineTo(_tcx(float(x)), _tcy(float(y)))
                _ctx.strokeStyle = _normalize_color(self._pen_color)
                _ctx.lineWidth = 1
                _ctx.stroke()
            self._x = float(x)
            self._y = float(y)
            if self._filling:
                self._fill_points.append((self._x, self._y))
            if _tracer_mode:
                _flush()

    def setpos(self, x, y=None):
        self.goto(x, y)

    def setposition(self, x, y=None):
        self.goto(x, y)

    def forward(self, d):
        if _anim_mode and self._speed > 0:
            rad = math.radians(self._heading)
            start_x, start_y = self._x, self._y
            self._x += d * math.cos(rad)
            self._y += d * math.sin(rad)
            if self._filling:
                self._fill_points.append((self._x, self._y))
            step = _SPEED_TABLE.get(self._speed, 5)
            steps = max(1, int(abs(d) / step))
            dx = d * math.cos(rad) / steps
            dy = d * math.sin(rad) / steps
            for i in range(steps):
                from_x = start_x + dx * i
                from_y = start_y + dy * i
                to_x = start_x + dx * (i + 1)
                to_y = start_y + dy * (i + 1)
                _anim_queue.append(('line', from_x, from_y, to_x, to_y, self._pen_down, self._pen_color))
        else:
            rad = math.radians(self._heading)
            target_x = self._x + d * math.cos(rad)
            target_y = self._y + d * math.sin(rad)
            self.goto(target_x, target_y)

    def fd(self, d):
        self.forward(d)

    def backward(self, d):
        self.forward(-d)

    def bk(self, d):
        self.forward(-d)

    def right(self, angle):
        if _anim_mode and self._speed > 0:
            start_heading = self._heading
            self._heading = (self._heading - angle) % 360
            step = max(2, _SPEED_TABLE.get(self._speed, 5) * 2)
            steps = max(1, int(abs(angle) / step))
            step_angle = angle / steps
            for i in range(steps):
                h = (start_heading - step_angle * i) % 360
                _anim_queue.append(('rotate', h))
        else:
            self._heading = (self._heading - angle) % 360
            if _tracer_mode:
                _flush()

    def rt(self, angle):
        self.right(angle)

    def left(self, angle):
        if _anim_mode and self._speed > 0:
            start_heading = self._heading
            self._heading = (self._heading + angle) % 360
            step = max(2, _SPEED_TABLE.get(self._speed, 5) * 2)
            steps = max(1, int(abs(angle) / step))
            step_angle = angle / steps
            for i in range(steps):
                h = (start_heading + step_angle * i) % 360
                _anim_queue.append(('rotate', h))
        else:
            self._heading = (self._heading + angle) % 360
            if _tracer_mode:
                _flush()

    def lt(self, angle):
        self.left(angle)

    def setheading(self, angle):
        if _anim_mode:
            _anim_queue.append(('setheading', angle % 360))
        self._heading = angle % 360
        if not _anim_mode and _tracer_mode:
            _flush()

    def seth(self, angle):
        self.setheading(angle)

    def color(self, *args):
        if len(args) == 1:
            self._pen_color = args[0]
            self._fill_color = args[0]
        elif len(args) >= 2:
            self._pen_color = args[0]
            self._fill_color = args[1]
        if _anim_mode:
            _anim_queue.append(('pencolor', self._pen_color))
            _anim_queue.append(('fillcolor', self._fill_color))
        return self._pen_color

    def pencolor(self, c=None):
        if c is not None:
            self._pen_color = c
            if _anim_mode:
                _anim_queue.append(('pencolor', c))
        return self._pen_color

    def fillcolor(self, c=None):
        if c is not None:
            self._fill_color = c
            if _anim_mode:
                _anim_queue.append(('fillcolor', c))
        return self._fill_color

    def begin_fill(self):
        self._filling = True
        self._fill_points = [(self._x, self._y)]
        if _anim_mode:
            _anim_queue.append(('begin_fill',))

    def end_fill(self):
        if _anim_mode:
            _anim_queue.append(('end_fill',))
            self._filling = False
            self._fill_points = []
        elif self._filling and _ctx:
            if len(self._fill_points) >= 3:
                _ctx.beginPath()
                _ctx.moveTo(_tcx(self._fill_points[0][0]), _tcy(self._fill_points[0][1]))
                for px, py in self._fill_points[1:]:
                    _ctx.lineTo(_tcx(px), _tcy(py))
                _ctx.closePath()
            else:
                _ctx.closePath()
            _ctx.fillStyle = _normalize_color(self._fill_color)
            _ctx.fill()
            self._filling = False
            self._fill_points = []

    def circle(self, radius, extent=None, steps=None):
        if _anim_mode:
            _anim_queue.append(('circle', radius, self._pen_down, self._pen_color, self._filling, self._fill_color))
        else:
            if not _ctx:
                return
            cx = _tcx(self._x)
            cy = _tcy(self._y) - radius
            r = abs(radius)
            _ctx.beginPath()
            _ctx.arc(cx, cy, r, 0, 2 * math.pi)
            if self._pen_down:
                _ctx.strokeStyle = _normalize_color(self._pen_color)
                _ctx.stroke()
            if self._filling:
                _ctx.fillStyle = _normalize_color(self._fill_color)
                _ctx.fill()
            if _tracer_mode:
                _flush()

    def dot(self, size=None, color=None):
        if _anim_mode:
            r = size / 2 if size else 2
            c = color if color else self._pen_color
            _anim_queue.append(('dot', self._x, self._y, r, c))
        else:
            if not _ctx:
                return
            r = size / 2 if size else 2
            _ctx.beginPath()
            _ctx.arc(_tcx(self._x), _tcy(self._y), r, 0, 2 * math.pi)
            _ctx.fillStyle = _normalize_color(color if color else self._pen_color)
            _ctx.fill()
            if _tracer_mode:
                _flush()

    def write(self, text, move=False, align="left", font=("Arial", 12, "normal")):
        if _anim_mode:
            family = font[0] if len(font) > 0 else "Arial"
            size = font[1] if len(font) > 1 else 12
            _anim_queue.append(('write', self._x, self._y, text, self._pen_color, family, size, align))
        else:
            if not _ctx:
                return
            family = font[0] if len(font) > 0 else "Arial"
            size = font[1] if len(font) > 1 else 12
            _ctx.font = f"{size}px {family}"
            _ctx.fillStyle = _normalize_color(self._pen_color)
            _ctx.textBaseline = "middle"
            _ctx.textAlign = align
            _ctx.fillText(str(text), _tcx(self._x), _tcy(self._y))
            if _tracer_mode:
                _flush()

    def clear(self):
        _clear_screen()

    def hideturtle(self):
        self._visible = False
        if _anim_mode:
            _anim_queue.append(('hideturtle',))
        elif _tracer_mode:
            _flush()

    def ht(self):
        self.hideturtle()

    def showturtle(self):
        self._visible = True
        if _anim_mode:
            _anim_queue.append(('showturtle',))
        elif _tracer_mode:
            _flush()

    def st(self):
        self.showturtle()

    def isvisible(self):
        return self._visible

    def shape(self, name=None):
        return "classic"

    def speed(self, s=None):
        if s is None:
            return self._speed
        self._speed = s

    @property
    def xcor(self):
        return self._x

    @property
    def ycor(self):
        return self._y

    def position(self):
        return (self._x, self._y)

    def pos(self):
        return (self._x, self._y)

    def heading(self):
        return self._heading

    def distance(self, x, y=None):
        if y is None:
            x, y = x
        return math.sqrt((self._x - x)**2 + (self._y - y)**2)

    def towards(self, x, y=None):
        if y is None:
            x, y = x
        return math.degrees(math.atan2(y - self._y, x - self._x)) % 360

    def clone(self):
        t = Turtle()
        t._x = self._x
        t._y = self._y
        t._heading = self._heading
        t._pen_down = self._pen_down
        t._pen_color = self._pen_color
        t._fill_color = self._fill_color
        t._visible = self._visible
        return t

    def getpen(self):
        return self

    def getscreen(self):
        return _screen_instance


class Screen:
    def __init__(self):
        global _screen_instance
        _screen_instance = self

    def title(self, name):
        pass

    def bgcolor(self, colour):
        global _bgcolor
        _bgcolor = colour
        _clear_screen()

    def setup(self, width, height):
        global _canvas_width, _canvas_height
        if width == 1.0 and height == 1.0:
            pass
        else:
            _canvas_width = int(width)
            _canvas_height = int(height)

    def tracer(self, arg1, arg2=None):
        global _tracer_mode
        _tracer_mode = bool(arg1)

    def update(self):
        _flush()

    def delay(self, d):
        pass

    def onclick(self, f, btn=1):
        _click_handlers.append(f)

    def onkey(self, f, key):
        if key not in _keydown_handlers:
            _keydown_handlers[key] = []
        _keydown_handlers[key].append(f)

    def onkeypress(self, f, key):
        if key not in _keydown_handlers:
            _keydown_handlers[key] = []
        _keydown_handlers[key].append(f)

    def onkeyrelease(self, f, key):
        if key not in _keyup_handlers:
            _keyup_handlers[key] = []
        _keyup_handlers[key].append(f)

    def listen(self):
        pass

    def window_width(self):
        return _canvas_width

    def window_height(self):
        return _canvas_height

    def addshape(self, name, shape=None):
        pass

    def bye(self):
        pass

    def exitonclick(self):
        pass

    def resetscreen(self):
        pass

    def clearscreen(self):
        _clear_screen()


def done():
    pass


def mainloop():
    pass


def bye():
    pass


def exitonclick():
    pass


def clear():
    _clear_screen()


def bgcolor(color):
    global _bgcolor
    _bgcolor = color


_default_turtle = None

def _get_default_turtle():
    global _default_turtle
    if _default_turtle is None:
        _default_turtle = Turtle()
    return _default_turtle


def speed(s=3):
    _get_default_turtle().speed(s)


def forward(d):
    _get_default_turtle().forward(d)


def fd(d):
    forward(d)


def backward(d):
    _get_default_turtle().forward(-d)


def bk(d):
    backward(d)


def right(a):
    _get_default_turtle().right(a)


def rt(a):
    right(a)


def left(a):
    _get_default_turtle().left(a)


def lt(a):
    left(a)


def penup():
    _get_default_turtle().penup()


def pu():
    penup()


def pendown():
    _get_default_turtle().pendown()


def pd():
    pendown()


def goto(x, y=None):
    _get_default_turtle().goto(x, y)


def setposition(x, y=None):
    goto(x, y)


def setpos(x, y=None):
    goto(x, y)


def setheading(h):
    _get_default_turtle().setheading(h)


def seth(h):
    setheading(h)


def circle(r, extent=None):
    _get_default_turtle().circle(r, extent)


def pencolor(c=None):
    return _get_default_turtle().pencolor(c)


def fillcolor(c=None):
    return _get_default_turtle().fillcolor(c)


def color(*args):
    return _get_default_turtle().color(*args)


def begin_fill():
    _get_default_turtle().begin_fill()


def end_fill():
    _get_default_turtle().end_fill()


def dot(size=None, color=None):
    _get_default_turtle().dot(size, color)


def write(text, move=False, align="left", font=("Arial", 12, "normal")):
    _get_default_turtle().write(text, move, align, font)


def hideturtle():
    _get_default_turtle().hideturtle()


def ht():
    hideturtle()


def showturtle():
    _get_default_turtle().showturtle()


def st():
    showturtle()


def tracer(n=True, delay=None):
    global _tracer_mode
    _tracer_mode = bool(n)


def update():
    _flush()


def Screen():
    global _screen_instance
    if _screen_instance is None:
        _screen_instance = Screen()
    return _screen_instance


def delay(d=None):
    pass


def sleep(seconds):
    pass


def mainloop():
    pass


def done():
    pass