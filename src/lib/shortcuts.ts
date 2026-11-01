/** Every keyboard shortcut, grouped by where it works. Support (and the ? key) shows these. */
export const SHORTCUT_GROUPS: Array<{ title: string; items: Array<{ keys: string[]; label: string }> }> = [
  {
    title: "EVERYWHERE",
    items: [
      { keys: ["Space"], label: "Play / pause" },
      { keys: ["←", "→"], label: "Back / forward 5 seconds" },
      { keys: ["F"], label: "Now Playing" },
      { keys: ["I"], label: "Immersive mode (clock and song on your displays)" },
      { keys: ["/"], label: "Search" },
      { keys: ["?"], label: "These shortcuts" },
      { keys: ["Esc"], label: "Back one step: close, then Home, then minimise (full screen stops at Home)" },
    ],
  },
  {
    title: "NOW PLAYING",
    items: [
      { keys: ["L"], label: "Lyrics" },
      { keys: ["Q"], label: "Queue" },
      { keys: ["T"], label: "Player style" },
      { keys: ["Esc"], label: "Close" },
    ],
  },
  {
    title: "IMMERSIVE MODE",
    items: [
      { keys: ["Space"], label: "Play / pause" },
      { keys: ["←", "→"], label: "Previous / next song" },
      { keys: ["V"], label: "Switch this display: clock, lyrics, artwork" },
      { keys: ["1", "–", "9"], label: "Show or hide on display 1 to 9" },
      { keys: ["Esc"], label: "Back to the app, with the player open" },
    ],
  },
  {
    title: "WHILE MINIMISED",
    items: [{ keys: ["F"], label: "Bring the window back with the player open" }],
  },
];
