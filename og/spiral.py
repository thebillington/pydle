import turtle as t

t.speed(0)
t.bgcolor("white")
t.pensize(2)

for i in range(36):
    for _ in range(4):
        t.forward(150)
        t.right(90)
    t.right(10)

t.pencolor("#50fa7b")
t.pensize(5)
t.circle(120)
