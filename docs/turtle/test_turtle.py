import turtle as t

t.speed(3)

# Test forward/fd/backward/bk
t.forward(80)
t.fd(40)
t.backward(30)
t.bk(20)

# Test right/rt/left/lt
t.right(90)
t.forward(50)
t.rt(45)
t.forward(50)
t.left(45)
t.lt(90)
t.forward(50)

# Test penup/pu/pendown/pd/isdown
t.penup()
t.forward(40)
assert t.isdown() == False, "penup failed"
t.pu()
t.pendown()
assert t.isdown() == True, "pendown failed"
t.pd()
t.forward(40)

# Test goto/setpos/setposition
t.goto(0, 100)
t.setpos(50, 100)
t.setposition(50, 50)

# Test setheading/seth
t.setheading(180)
t.seth(0)
t.forward(30)

# Test color/pencolor/fillcolor
t.color('blue')
t.pencolor('green')
t.fillcolor('yellow')

# Test begin_fill/end_fill
t.begin_fill()
t.forward(40)
t.right(90)
t.forward(40)
t.right(90)
t.forward(40)
t.right(90)
t.forward(40)
t.right(90)
t.end_fill()

# Test position/pos/xcor/ycor/heading
pos = t.position()
x = t.xcor()
y = t.ycor()
h = t.heading()
print(f"pos={pos} x={x} y={y} heading={h}")

# Test distance/towards
t.goto(0, 0)
d = t.distance(100, 0)
ang = t.towards(100, 100)
print(f"distance={d} towards={ang}")
assert d == 100.0, f"distance failed: {d}"

# Test circle
t.penup()
t.goto(-100, -100)
t.pendown()
t.circle(30)

# Test dot
t.penup()
t.goto(0, -100)
t.pendown()
t.dot(10, 'red')

# Test write
t.penup()
t.goto(-50, -150)
t.write("hello", font=("Arial", 16, "normal"))

# Test hideturtle/ht/showturtle/st/isvisible
t.hideturtle()
assert t.isvisible() == False, "hideturtle failed"
t.ht()
t.showturtle()
assert t.isvisible() == True, "showturtle failed"
t.st()

# Test shape
s = t.shape()
assert s == "classic", f"shape failed: {s}"

# Test clone
t.penup()
t.goto(50, -150)
t2 = t.clone()
print(f"clone x={t2.xcor} y={t2.ycor} heading={t2.heading()}")

# Test tracer/update
t.tracer(0)
t.goto(100, -150)
t.update()
t.tracer(1)

# Test speed
t.speed(0)
t.forward(200)
t.speed(5)

# Test clear
t.clear()

# Test bgcolor
t.bgcolor('white')

# Test Screen
s = t.Screen()
print(f"screen width={s.window_width()} height={s.window_height()}")

# Test delay/sleep (no-ops)
t.delay(10)
t.sleep(0.01)

# Test done/mainloop/bye/exitonclick (no-ops)
t.done()
t.mainloop()
t.bye()
t.exitonclick()

print("ALL TESTS PASSED")