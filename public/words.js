// Word lists for game codes like "lucky-river". Short, easy to say out loud and type on a phone.

export const ADJECTIVES = [
  "lucky", "wild", "royal", "golden", "silver", "sly", "bold", "brave", "cosmic", "crafty",
  "daring", "dusty", "electric", "fancy", "fearless", "fiery", "frosty", "giant", "happy", "hidden",
  "jolly", "lazy", "little", "loud", "magic", "mighty", "misty", "noble", "quick", "quiet",
  "rapid", "rowdy", "rusty", "salty", "secret", "shady", "shiny", "silent", "slick", "smooth",
  "snappy", "sneaky", "sunny", "swift", "tall", "tiny", "tricky", "velvet", "wicked", "windy",
  "witty", "zesty", "crimson", "emerald", "scarlet", "neon", "lunar", "solar", "stormy", "spicy",
  "savvy", "steady", "cool", "cheeky", "clever", "cozy", "curious", "dandy", "eager", "epic",
  "fuzzy", "groovy", "hasty", "icy", "jazzy", "keen", "lively", "mellow", "nifty", "plucky",
  "proud", "rugged", "rustic", "sleepy", "spotted", "stealthy", "sturdy", "super", "toasty", "vivid",
  "zany", "bouncy", "breezy", "classy", "dapper", "funky", "gentle", "humble", "mystic", "speedy",
];

export const NOUNS = [
  "river", "flush", "ace", "king", "queen", "jack", "joker", "bluff", "chip", "stack",
  "dealer", "flop", "shark", "whale", "tiger", "eagle", "falcon", "fox", "wolf", "bear",
  "otter", "panda", "rhino", "cobra", "raven", "badger", "bison", "camel", "coyote", "dragon",
  "gator", "gecko", "hawk", "heron", "koala", "lemur", "lion", "llama", "lynx", "moose",
  "owl", "parrot", "puma", "rabbit", "rooster", "salmon", "walrus", "squid", "toucan", "turtle",
  "yak", "zebra", "pickle", "taco", "waffle", "pretzel", "muffin", "nacho", "biscuit", "cactus",
  "comet", "rocket", "canyon", "desert", "harbor", "island", "jungle", "meadow", "mountain", "ocean",
  "prairie", "summit", "thunder", "tornado", "volcano", "lagoon", "bayou", "diamond", "spade", "heart",
  "club", "cowboy", "outlaw", "ranger", "bandit", "pirate", "wizard", "captain", "maverick", "rebel",
  "gambler", "tycoon", "sheriff", "nugget", "banjo", "jukebox", "lantern", "marble", "saddle", "domino",
];

// Accepts "Lucky River", "lucky river", "LUCKY-RIVER" etc. and returns "lucky-river" (or null)
export function normalizeCode(input) {
  const parts = String(input || "").toLowerCase().trim().split(/[\s\-_]+/).filter(Boolean);
  if (parts.length !== 2 || !parts.every((p) => /^[a-z]{2,12}$/.test(p))) return null;
  return parts.join("-");
}
