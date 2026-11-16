import { polyfillCountryFlagEmojis } from "country-flag-emoji-polyfill";
import { Game } from "./game";
import { fetchBest } from "./net";
import { Ui } from "./ui";

// Windows has no flag emoji: load a small flags-only font there (self-hosted, Twemoji, CC-BY 4.0)
polyfillCountryFlagEmojis("Twemoji Country Flags", "/fonts/TwemojiCountryFlags.woff2");

const ui = new Ui();
const game = new Game(document.getElementById("stage")!, ui);
ui.init({
  fly: (name, paint, flag) => game.join(name, paint, flag),
  again: () => game.respawn(),
  reconnect: () => game.connect(),
  leave: () => {
    game.leaveArena();
    game.connect();
  },
  touchFire: (on) => game.setTouchFire(on),
  touchBoost: (on) => game.setTouchBoost(on),
  roll: () => game.roll(),
  refreshBest: () => fetchBest(),
});
game.connect();

// for probes and debugging
(window as unknown as { __bandits: unknown }).__bandits = game;
