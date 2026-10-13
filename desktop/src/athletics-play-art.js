/* Play art for an edition launch page, chosen by the manifest's athlete.sport. The launch page
 * names no sport: it asks playArt(sport, hand) and draws what comes back, or nothing. A sport
 * without art here gets no play diagram. Shapes are plain data (no markup, no script), drawn on a
 * 1440 x 900 field; the passer rolls out to the throwing-hand side, so a right hand mirrors the
 * left-hand play across the field's centre line. */
(function (root, factory) {
  const exported = factory();
  if (typeof module === "object" && module.exports) module.exports = exported;
  if (root) root.yurAthleticsPlays = exported;
})(typeof window === "undefined" ? null : window, function () {
  "use strict";
  const WIDTH = 1440,
    HEIGHT = 900;
  const LINE = "rgba(228,228,231,0.26)",
    PLAYER = "rgba(228,228,231,0.4)",
    DEFENDER = "rgba(228,228,231,0.28)";
  const BLUE = "#3b82f6",
    BLUE_LIGHT = "#60a5fa",
    BLUE_GLOW = "rgba(59,130,246,0.18)";

  // A path is a list of segments: ['M', x, y], ['L', x, y], ['Q', x1, y1, x, y], ['C', x1, y1, x2, y2, x, y], ['Z'].
  const mirrorPath = (segments) =>
    segments.map(([command, ...values]) => [
      command,
      ...values.map((value, index) => (index % 2 ? value : WIDTH - value)),
    ]);
  const pathData = (segments) =>
    segments.map(([command, ...values]) => command + values.join(" ")).join("");
  const polyline = (points) =>
    points.map(([x, y], index) => [index ? "L" : "M", x, y]);
  const triangle = (points) => [...polyline(points), ["Z"]];
  const cross = ([x, y]) => [
    ["M", x - 6, y - 6],
    ["L", x + 6, y + 6],
    ["M", x + 6, y - 6],
    ["L", x - 6, y + 6],
  ];

  // The left-hand version: the passer takes the snap at (720, 790), rolls left and throws the post.
  const football = Object.freeze({
    // Yard lines every 100 units; the line of scrimmage (700) is drawn on its own, brighter.
    field: [100, 200, 300, 400, 500, 600, 800].map((y) => [
      ["M", 0, y],
      ["L", WIDTH, y],
    ]),
    scrimmage: [
      ["M", 0, 700],
      ["L", WIDTH, 700],
    ],
    routes: [
      {
        path: polyline([
          [180, 732],
          [180, 150],
        ]),
        delay: 0.2,
      },
      {
        path: polyline([
          [380, 742],
          [380, 480],
          [560, 230],
        ]),
        delay: 0.3,
      },
      {
        path: polyline([
          [850, 740],
          [850, 270],
        ]),
        delay: 0.35,
      },
      {
        path: polyline([
          [1260, 732],
          [1260, 400],
          [1228, 440],
        ]),
        delay: 0.25,
      },
      {
        path: [
          ["M", 770, 790],
          ["C", 860, 800, 930, 760, 960, 700],
        ],
        delay: 0.4,
      },
    ],
    heads: [
      [
        [180, 150],
        [174, 162],
        [186, 162],
      ],
      [
        [560, 230],
        [547, 235],
        [556, 243],
      ],
      [
        [850, 270],
        [844, 282],
        [856, 282],
      ],
      [
        [1228, 440],
        [1232, 427],
        [1240, 436],
      ],
      [
        [960, 700],
        [948, 702],
        [955, 711],
      ],
    ].map(triangle),
    rollout: [
      ["M", 720, 790],
      ["C", 680, 806, 640, 806, 604, 798],
    ],
    pass: [
      ["M", 604, 798],
      ["Q", 520, 480, 560, 232],
    ],
    players: [
      [640, 730],
      [680, 730],
      [720, 730],
      [760, 730],
      [800, 730],
      [180, 732],
      [380, 742],
      [850, 740],
      [1260, 732],
      [770, 790],
    ],
    passer: [720, 790],
    defenders: [
      [650, 690],
      [705, 690],
      [745, 690],
      [790, 690],
      [560, 640],
      [720, 640],
      [880, 640],
      [180, 680],
      [1260, 680],
      [470, 420],
      [970, 420],
    ],
  });

  function footballShapes(side) {
    const flip = side === "right",
      path = (segments) => pathData(flip ? mirrorPath(segments) : segments),
      x = (value) => (flip ? WIDTH - value : value);
    const shapes = [];
    shapes.push({
      tag: "path",
      role: "field",
      attrs: {
        d: football.field.map(path).join(""),
        fill: "none",
        stroke: "rgba(228,228,231,0.05)",
        "stroke-width": 1,
      },
    });
    shapes.push({
      tag: "path",
      role: "scrimmage",
      attrs: {
        d: path(football.scrimmage),
        fill: "none",
        stroke: "rgba(228,228,231,0.14)",
        "stroke-width": 1,
      },
    });
    for (const route of football.routes)
      shapes.push({
        tag: "path",
        role: "route",
        motion: "draw",
        delay: route.delay,
        attrs: {
          d: path(route.path),
          fill: "none",
          stroke: LINE,
          "stroke-width": 2,
          "stroke-linecap": "square",
        },
      });
    shapes.push({
      tag: "path",
      role: "heads",
      motion: "fade",
      delay: 1.6,
      attrs: {
        d: football.heads.map(path).join(""),
        fill: "rgba(228,228,231,0.3)",
        stroke: "none",
      },
    });
    shapes.push({
      tag: "path",
      role: "rollout",
      motion: "draw",
      delay: 0.6,
      attrs: {
        d: path(football.rollout),
        fill: "none",
        stroke: BLUE,
        "stroke-width": 2.5,
      },
    });
    shapes.push({
      tag: "path",
      role: "pass-glow",
      motion: "draw",
      delay: 1.1,
      attrs: {
        d: path(football.pass),
        fill: "none",
        stroke: BLUE_GLOW,
        "stroke-width": 10,
      },
    });
    shapes.push({
      tag: "path",
      role: "pass",
      motion: "fade",
      delay: 1.6,
      attrs: {
        d: path(football.pass),
        fill: "none",
        stroke: BLUE_LIGHT,
        "stroke-width": 2,
        "stroke-dasharray": "6 8",
      },
    });
    for (const [cx, cy] of football.players)
      shapes.push({
        tag: "circle",
        role: "player",
        attrs: {
          cx: x(cx),
          cy,
          r: 9,
          fill: "none",
          stroke: PLAYER,
          "stroke-width": 2,
        },
      });
    shapes.push({
      tag: "circle",
      role: "passer",
      attrs: {
        cx: x(football.passer[0]),
        cy: football.passer[1],
        r: 10,
        fill: "#000000",
        stroke: "#ffffff",
        "stroke-width": 2.5,
      },
    });
    shapes.push({
      tag: "path",
      role: "defense",
      attrs: {
        d: football.defenders.map((point) => path(cross(point))).join(""),
        fill: "none",
        stroke: DEFENDER,
        "stroke-width": 2,
      },
    });
    return shapes;
  }

  const PLAYS = Object.freeze({ football: footballShapes });

  // { sport, side, viewBox, shapes } for a sport with art, otherwise null. The side is the throwing
  // hand's: 'left' for a left hand, 'right' otherwise.
  function playArt(sport, hand) {
    if (typeof sport !== "string" || !Object.hasOwn(PLAYS, sport)) return null;
    const side = hand === "left" ? "left" : "right";
    return Object.freeze({
      sport,
      side,
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      shapes: Object.freeze(
        PLAYS[sport](side).map((shape) => Object.freeze(shape)),
      ),
    });
  }

  return Object.freeze({
    WIDTH,
    HEIGHT,
    SPORTS: Object.freeze(Object.keys(PLAYS)),
    playArt,
    mirrorPath,
    pathData,
  });
});
