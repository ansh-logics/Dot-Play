/**
 * GTA-style radio stations. Each one is a hand-picked list of real songs (artist + title)
 * that are looked up and streamed the same way as any search result. No audio is bundled.
 * The station names refer to the games' radio lineups; the badges and colours are our own.
 */

export type RadioEra = "vi" | "v" | "vc"

export interface RadioEraInfo {
  id: RadioEra
  label: string
  /** Short tag shown on the wheel's era switcher. */
  short: string
  year: string
}

export const RADIO_ERAS: RadioEraInfo[] = [
  { id: "vi", label: "Leonida", short: "VI", year: "2026" },
  { id: "v", label: "Los Santos", short: "V", year: "2013" },
  { id: "vc", label: "Vice City '86", short: "VC", year: "2002" },
]

export interface RadioStation {
  id: string
  era: RadioEra
  name: string
  /** Dial frequency, when the station has one. */
  freq?: string
  genre: string
  vibe: string
  host: string
  /** Badge colours: [fill, ink]. */
  colors: [string, string]
  /** Up to three letters for the round badge. */
  monogram: string
  /** False when the lineup comes from launch guides rather than Rockstar's own reveal. */
  confirmed?: boolean
  songs: [artist: string, title: string][]
}

export const RADIO_STATIONS: RadioStation[] = [
  // ---- Leonida (VI) -----------------------------------------------------------------
  {
    id: "vi-flash-fm", era: "vi", name: "Flash FM", genre: "Pop & dance", vibe: "Neon pop for the causeway at golden hour",
    host: "Robyn & Alex", colors: ["#ff3e9a", "#1a0b2e"], monogram: "FL", confirmed: true,
    songs: [
      ["Robyn", "Blow My Mind"], ["Justin Bieber", "Friends"], ["Charli xcx", "Good Ones"], ["MGMT", "Electric Feel"],
      ["Zara Larsson", "Midnight Sun"], ["Dua Lipa", "Houdini"], ["Lorde", "Green Light"], ["Daft Punk", "Around the World"],
      ["Tove Lo", "Blood In Your Eyes"], ["PinkPantheress", "Sexy Magic"],
    ],
  },
  {
    id: "vi-cocoteo-fm", era: "vi", name: "Cocoteo FM", genre: "Reggaeton, dembow, bachata", vibe: "Street-party Latin heat",
    host: "El Martillo & La Gata", colors: ["#ffb347", "#3a0a1e"], monogram: "CO", confirmed: true,
    songs: [
      ["Bad Bunny", "EoO"], ["Axel Rulay Farruko El Alfa", "Si Es Trucho Es Trucho Remix"], ["Romeo Santos", "Canalla"],
      ["Bad Bunny", "Otra Noche en Miami"], ["ROSALÍA", "CANDY"], ["KAROL G Mariah Angeliq", "EL MAKINON"],
      ["Rauw Alejandro", "Macacoa 2000"], ["Fuerza Regida", "Suzuki"],
    ],
  },
  {
    id: "vi-back-country", era: "vi", name: "Back Country Radio", genre: "Outlaw country", vibe: "Swamp roads and pickup trucks",
    host: "MW & Delta Dawne", colors: ["#c8873a", "#1f140a"], monogram: "BC", confirmed: true,
    songs: [
      ["Waylon Jennings Willie Nelson", "Just to Satisfy You"], ["David Allan Coe", "Need a Little Time Off for Bad Behavior"],
      ["Loretta Lynn", "Don't Come Home A-Drinkin'"], ["Hank Williams Jr. Waylon Jennings", "The Conversation"],
      ["George Strait", "The Fireman"], ["Tammy Wynette", "Talkin' to Myself Again"], ["Glen Campbell", "Rhinestone Cowboy"],
      ["Morgan Wallen", "Last Thing You Need"],
    ],
  },
  {
    id: "vi-afrobank-fm", era: "vi", name: "AfroBank FM", genre: "Afrobeats & amapiano", vibe: "Warm bass and late-night log drums",
    host: "Burna & Palmsy", colors: ["#19d3c5", "#05201e"], monogram: "AB", confirmed: true,
    songs: [
      ["Omah Lay", "Holy Ghost"], ["Asake", "Joha"], ["Pat Thomas Ebo Taylor", "Gye Wani"], ["DJ Lag Robot Boii Kamo Mphela", "Shay'sana"],
      ["Burna Boy Seyi Vibez", "Giza"], ["Hugh Masekela", "Run No More"],
    ],
  },
  {
    id: "vi-the-chamber", era: "vi", name: "The Chamber", freq: "106.6", genre: "Metal", vibe: "Riffs loud enough to rattle the trunk",
    host: "DJ Kerry & DJ Tom", colors: ["#d71921", "#0b0b0b"], monogram: "CH", confirmed: true,
    songs: [
      ["Slayer", "Raining Blood"], ["Metallica", "Master of Puppets"], ["Black Sabbath", "I"], ["System of a Down", "Sugar"],
      ["Pantera", "I'm Broken"], ["Iron Maiden", "The Trooper"],
    ],
  },
  {
    id: "vi-dirty-south", era: "vi", name: "Dirty South Classics", genre: "Southern rap", vibe: "Bass in the trunk, Miami to Atlanta",
    host: "Trick & Trina", colors: ["#ffd166", "#2b1b5e"], monogram: "DS", confirmed: true,
    songs: [
      ["David Banner Lil' Flip", "Like a Pimp"], ["JT Money Solé", "Who Dat"], ["DJ Khaled Trick Daddy Rick Ross Pitbull", "Born N Raised"],
      ["OutKast", "Player's Ball"], ["Lil Wayne", "A Milli"], ["Three 6 Mafia", "Side 2 Side"],
    ],
  },
  {
    id: "vi-vcrr", era: "vi", name: "VCRR", genre: "Modern hip-hop", vibe: "Today's heavy rotation", host: "JT & DJ Stevie J",
    colors: ["#6a3fb5", "#f4ecff"], monogram: "VC", confirmed: false,
    songs: [
      ["Travis Scott", "RHYNO"], ["Drake", "Nonstop"], ["Cardi B", "Don't Chart"], ["Real Boston Richey", "Help Me"],
      ["Yung Lean Future Metro Boomin", "That's It"],
    ],
  },
  {
    id: "vi-vice-city-fm", era: "vi", name: "Vice City FM", genre: "'80s pop & new wave", vibe: "Pastel suits and synth hooks",
    host: "Vice City FM", colors: ["#3fe0f0", "#2b0a3d"], monogram: "VCF", confirmed: false,
    songs: [
      ["Tears for Fears", "Head Over Heels"], ["The Cure", "Just Like Heaven"], ["Depeche Mode", "People Are People"],
      ["The Pointer Sisters", "Hot Together"], ["Wang Chung", "Everybody Have Fun Tonight"], ["David Lee Roth", "Just Like Paradise"],
    ],
  },
  {
    id: "vi-v-rock", era: "vi", name: "V-Rock", genre: "Classic rock", vibe: "Highway anthems with the top down",
    host: "Lindsey & Michael", colors: ["#ff6b4a", "#1d0d06"], monogram: "VR", confirmed: false,
    songs: [
      ["Tom Petty", "Love Is a Long Road"], ["Dire Straits", "Money for Nothing"], ["Van Halen", "Panama"], ["Queen", "Hammer to Fall"],
      ["Eddie Money", "Take Me Home Tonight"], ["Gerry Rafferty", "Right Down the Line"], ["The Clash", "Rock the Casbah"],
      ["Jay Ferguson", "Thunder Island"], ["Blue Öyster Cult", "Shooting Shark"],
    ],
  },
  {
    id: "vi-emotion", era: "vi", name: "Emotion", freq: "98.3", genre: "Soft rock & ballads", vibe: "Power ballads for the long drive home",
    host: "Emotion 98.3", colors: ["#ff5fa8", "#2a0716"], monogram: "EM", confirmed: false,
    songs: [
      ["Phil Collins", "In the Air Tonight"], ["Heart", "Alone"], ["Roxette", "Listen to Your Heart"], ["The Cars", "Drive"],
      ["Chris Rea", "Fool (If You Think It's Over)"], ["Stevie Nicks", "For What It's Worth"],
    ],
  },
  {
    id: "vi-honey-fm", era: "vi", name: "Honey FM", genre: "R&B & soul", vibe: "Slow jams after midnight", host: "Chilli & T-Boz",
    colors: ["#ffb347", "#2a1504"], monogram: "HN", confirmed: false,
    songs: [["TLC", "Creep"], ["Brandy", "Baby"], ["Mariah Carey", "Vision of Love"]],
  },
  {
    id: "vi-radio-la-ola", era: "vi", name: "Radio La Ola", genre: "Salsa & classic Latin", vibe: "Little Havana on a Sunday",
    host: "Gloria & Emilio", colors: ["#e0218a", "#fff4e0"], monogram: "LO", confirmed: false,
    songs: [["Gloria Estefan", "Mi Tierra"], ["Celia Cruz", "Bemba Colorá"], ["Héctor Lavoe", "Periódico de Ayer"]],
  },
  {
    id: "vi-radio-on-u", era: "vi", name: "Radio On-U", genre: "Reggae & dub", vibe: "Echo chambers and heavy bass",
    host: "Adrian Sherwood", colors: ["#2fbf71", "#08160c"], monogram: "OU", confirmed: false,
    songs: [["Gregory Isaacs", "Mr. Cop"], ["Horace Andy", "Skylarking"], ["Janet Kay", "Silly Games"]],
  },
  {
    id: "vi-gloriana-blues", era: "vi", name: "Gloriana Blues Radio", genre: "Blues", vibe: "Juke joints by the bayou",
    host: "Buddy & Keith", colors: ["#3a6fd8", "#060d1f"], monogram: "GB", confirmed: false,
    songs: [["Muddy Waters", "Got My Mojo Working"], ["Howlin' Wolf", "Smokestack Lightnin'"], ["Keith Richards", "Bright Lights, Big City"]],
  },
  {
    id: "vi-stockyard-fm", era: "vi", name: "Stockyard FM", genre: "Indie dance", vibe: "Warehouse sweat and cowbell",
    host: "PinkPantheress & The Dare", colors: ["#c2187a", "#fde7f3"], monogram: "SY", confirmed: false,
    songs: [["LCD Soundsystem", "North American Scum"], ["Justice RIMON", "Afterimage"], ["Caribou", "Never Come Back"], ["Justice Tame Impala", "Flower in a Hurricane"]],
  },
  {
    id: "vi-circoloco", era: "vi", name: "CircoLoco Records Radio", genre: "House & techno", vibe: "Sunrise at the after-party",
    host: "Seth Troxler & Antonio Carbonaro", colors: ["#f2f2f2", "#111111"], monogram: "CL", confirmed: false,
    songs: [
      ["Skream Jackmaster", "The Attention Deficit Track"], ["Prospa Murda Beatz", "Baby"], ["PAWSA", "COLLECT THE COMMAS"],
      ["Michael Bibi KETTAMA", "MYSTERY OF RAW"], ["DJ Koze", "XTC"],
    ],
  },
  {
    id: "vi-worldwide-fm", era: "vi", name: "Worldwide FM", genre: "Global club & jazz", vibe: "Crate-digger finds", host: "Gilles Peterson",
    colors: ["#ffd166", "#14213d"], monogram: "WW", confirmed: false,
    songs: [["Jamiroquai", "Smile"], ["Roberta Flack", "The First Time Ever I Saw Your Face"], ["Floating Points", "Del Oro"]],
  },
  {
    id: "vi-leonida-jazz", era: "vi", name: "Leonida Jazz Radio", genre: "Jazz fusion", vibe: "Humid nights, loose grooves",
    host: "Leonida Jazz", colors: ["#4b2a8c", "#ffd166"], monogram: "LJ", confirmed: false,
    songs: [["Weather Report", "Birdland"], ["Thundercat", "Fleer Ultra"], ["Moses Boyd", "Rye Lane Shuffle"]],
  },

  // ---- Los Santos (V) ---------------------------------------------------------------
  {
    id: "v-non-stop-pop", era: "v", name: "Non-Stop-Pop FM", genre: "Pop hits", vibe: "Glossy mall-pop, all day long", host: "Cara Delevingne",
    colors: ["#ff3e9a", "#ffffff"], monogram: "NSP",
    songs: [
      ["Robbie Williams", "Feel"], ["All Saints", "Pure Shores"], ["Britney Spears", "Gimme More"], ["Rihanna", "Only Girl (In the World)"],
      ["Lady Gaga", "Applause"], ["Amerie", "1 Thing"], ["Nelly Furtado", "Promiscuous"], ["Stardust", "Music Sounds Better With You"],
      ["Modjo", "Lady (Hear Me Tonight)"], ["Robyn", "With Every Heartbeat"], ["Jamiroquai", "Alright"], ["Wham!", "Everything She Wants"],
      ["Moloko", "Sing It Back"], ["Corinne Bailey Rae", "Put Your Records On"],
    ],
  },
  {
    id: "v-radio-los-santos", era: "v", name: "Radio Los Santos", genre: "West Coast hip-hop", vibe: "Modern LA rap", host: "Big Boy",
    colors: ["#ffd166", "#111111"], monogram: "RLS",
    songs: [
      ["Kendrick Lamar", "A.D.H.D"], ["Danny Brown", "Dip"], ["ScHoolboy Q", "Hands on the Wheel"], ["Ab-Soul", "Illuminate"],
      ["Gangrene", "Bassheads"], ["Future", "How It Was"], ["Clyde Carson", "Pretty Girls"], ["Problem Glasses Malone", "Say That Then"],
      ["Nipsey Hussle", "Checc Me Out"],
    ],
  },
  {
    id: "v-ls-rock", era: "v", name: "Los Santos Rock Radio", genre: "Classic rock", vibe: "Dad-rock highway cruising", host: "Kenny Loggins",
    colors: ["#ff6b4a", "#1a0f08"], monogram: "LSR",
    songs: [
      ["Kenny Loggins", "Danger Zone"], ["Def Leppard", "Photograph"], ["Foreigner", "Waiting for a Girl Like You"],
      ["Elton John", "Saturday Night's Alright for Fighting"], ["Gerry Rafferty", "Baker Street"], ["ZZ Top", "Gimme All Your Lovin'"],
      ["Steve Winwood", "Higher Love"], ["Stevie Nicks", "I Can't Wait"], ["Chicago", "If You Leave Me Now"], ["Bob Seger", "Hollywood Nights"],
      ["Billy Squier", "Lonely Is the Night"], ["Pat Benatar", "Shadows of the Night"], ["Robert Plant", "Big Log"], ["The Cult", "Rain"],
    ],
  },
  {
    id: "v-channel-x", era: "v", name: "Channel X", genre: "Punk", vibe: "SoCal hardcore", host: "Keith Morris",
    colors: ["#e8e8e8", "#c2187a"], monogram: "X",
    songs: [
      ["Black Flag", "My War"], ["Circle Jerks", "Rock House"], ["Fear", "The Mouth Don't Stop"], ["Descendents", "Pervert"],
      ["The Germs", "Lexicon Devil"], ["T.S.O.L.", "Abolish Government"], ["D.O.A.", "The Enemy"], ["Suicidal Tendencies", "Subliminal"],
      ["OFF!", "What's Next"], ["Adolescents", "Amoeba"], ["The Weirdos", "Life of Crime"], ["Youth Brigade", "Sink with Kalifornija"],
    ],
  },
  {
    id: "v-west-coast-classics", era: "v", name: "West Coast Classics", genre: "'90s West Coast rap", vibe: "Low-riders on Grove Street", host: "DJ Pooh",
    colors: ["#2fbf71", "#0b1a10"], monogram: "WCC",
    songs: [
      ["Dr. Dre Snoop Dogg", "Still D.R.E."], ["2Pac", "Ambitionz Az a Ridah"], ["Ice Cube", "You Know How We Do It"],
      ["N.W.A", "Appetite for Destruction"], ["Tha Dogg Pound", "What Would U Do?"], ["Kurupt", "C-Walk"], ["DJ Quik", "Dollaz + Sense"],
      ["MC Eiht", "Streiht Up Menace"], ["The D.O.C.", "It's Funky Enough"], ["Too $hort", "So You Want to Be a Gangster"],
    ],
  },
  {
    id: "v-rebel-radio", era: "v", name: "Rebel Radio", genre: "Outlaw country & rockabilly", vibe: "Backroads in Blaine County", host: "Jesco White",
    colors: ["#c8873a", "#2a1a08"], monogram: "RR",
    songs: [
      ["Waylon Jennings", "Are You Sure Hank Done It This Way"], ["Willie Nelson", "Whiskey River"], ["Charlie Feathers", "Can't Hardly Stand It"],
      ["Hank Thompson", "It Don't Hurt Anymore"], ["Hasil Adkins", "Get Out of My Car"], ["Ozark Mountain Daredevils", "If You Wanna Get to Heaven"],
      ["Jerry Reed", "You Took All the Ramblin' Out of Me"], ["Johnny Paycheck", "It Won't Be Long"], ["Charley Pride", "Kaw-Liga"],
    ],
  },
  {
    id: "v-soulwax-fm", era: "v", name: "Soulwax FM", genre: "Electro & techno", vibe: "Sweaty Belgian club", host: "Soulwax",
    colors: ["#111111", "#ff3e9a"], monogram: "SW",
    songs: [
      ["Tiga", "Plush"], ["Daniel Avery", "Water Jump"], ["Matias Aguayo", "El Sucu Tucu"], ["Joakim", "Dreamin'"],
      ["Tom Rowlands", "Nothing But Pleasure"], ["Mim Suleiman", "Mingi"], ["Jackson and His Computer Band", "Arp #1"], ["Goose", "Synrise Soulwax Remix"],
    ],
  },
  {
    id: "v-flylo-fm", era: "v", name: "FlyLo FM", genre: "Beats & IDM", vibe: "Late-night LA beat scene", host: "Flying Lotus",
    colors: ["#6a3fb5", "#19d3c5"], monogram: "FLO",
    songs: [
      ["Flying Lotus", "Crosswerved"], ["Aphex Twin", "Windowlicker"], ["Thundercat", "Oh Sheit It's X"], ["Outkast", "Elevators (Me & You)"],
      ["Clams Casino", "Crystals"], ["Hudson Mohawke", "100hrs"], ["Captain Murphy", "Evil Grin"], ["Dabrye", "Encoded Flow"],
      ["Kingdom", "Bank Head"], ["DJ Rashad", "Let It Go"],
    ],
  },
  {
    id: "v-the-lowdown", era: "v", name: "The Lowdown", freq: "91.1", genre: "'60s–'70s soul & funk", vibe: "Blaxploitation cool", host: "Pam Grier",
    colors: ["#ff8a3d", "#1d0b02"], monogram: "LOW",
    songs: [
      ["The Delfonics", "Ready or Not Here I Come"], ["Aaron Neville", "Hercules"], ["Marlena Shaw", "California Soul"],
      ["The Undisputed Truth", "Smiling Faces Sometimes"], ["The Soul Searchers", "Ashley's Roachclip"], ["The Chi-Lites", "Are You My Woman"],
      ["Clarence Reid", "Nobody but You Babe"], ["The Five Stairsteps", "Don't Change Your Love"],
    ],
  },
  {
    id: "v-space", era: "v", name: "Space", freq: "103.2", genre: "'80s funk & boogie", vibe: "Cosmic funk from the mothership", host: "Bootsy Collins",
    colors: ["#e0218a", "#ffd166"], monogram: "SP",
    songs: [
      ["Bootsy's Rubber Band", "I'd Rather Be with You"], ["Zapp", "Heartbreaker"], ["Rick James", "Give It to Me Baby"], ["Kano", "Can't Hold Back"],
      ["Evelyn King", "I'm in Love"], ["D Train", "You're the One for Me"], ["Sho Nuff", "Funky Thing"], ["Taana Gardner", "Heartbeat"],
      ["Stevie Wonder", "Skeletons"], ["One Way", "Cutie Pie"],
    ],
  },
  {
    id: "v-vinewood-blvd", era: "v", name: "Vinewood Boulevard Radio", genre: "Garage rock", vibe: "Scuzzy LA garage", host: "Wavves",
    colors: ["#f4ecff", "#2b1b5e"], monogram: "VB",
    songs: [
      ["Wavves", "Nine Is God"], ["FIDLAR", "Cocaine"], ["Bass Drum of Death", "Crawling After You"], ["Ty Segall Band", "Diddy Wah Diddy"],
      ["Thee Oh Sees", "The Dream"], ["The Black Angels", "Black Grease"], ["Hot Snakes", "Retrofitted"], ["The Men", "Turn It Around"],
      ["Moon Duo", "Sleepwalker"],
    ],
  },
  {
    id: "v-blue-ark", era: "v", name: "Blue Ark", genre: "Reggae & dancehall", vibe: "Dub-soaked island", host: "Lee \"Scratch\" Perry",
    colors: ["#2f7bd8", "#ffd166"], monogram: "BA",
    songs: [
      ["Lee Scratch Perry The Upsetters", "I Am a Madman"], ["Chronixx", "Odd Ras"], ["Gregory Isaacs", "Night Nurse"],
      ["Dennis Brown", "Money in My Pocket"], ["Protoje", "Kingston Be Wise"], ["Joe Gibbs & The Professionals", "Chapter Three"],
      ["Vybz Kartel", "We Never Fear Dem"], ["Konshens", "Gun Shot a Fire"], ["Yellowman", "Nobody Move Nobody Get Hurt"],
    ],
  },
  {
    id: "v-worldwide-fm", era: "v", name: "WorldWide FM", genre: "Global beats & downtempo", vibe: "Crate-digger's passport", host: "Gilles Peterson",
    colors: ["#ffd166", "#0e0b2e"], monogram: "WWF",
    songs: [
      ["Cashmere Cat", "Mirror Maru"], ["Swindle", "Forest Funk"], ["Toro y Moi", "Rose Quartz"], ["Owiny Sigoma Band", "Hera Ma Nyaka"],
      ["Mala", "Ghost"], ["Clap! Clap!", "Viajero"], ["Hackman", "Forgotten Notes"],
    ],
  },
  {
    id: "v-mirror-park", era: "v", name: "Radio Mirror Park", genre: "Indie electro & chillwave", vibe: "Hipster neon by the lake", host: "Twin Shadow",
    colors: ["#3fe0f0", "#1a1446"], monogram: "RMP",
    songs: [
      ["Twin Shadow", "Old Love / New Love"], ["Toro y Moi", "So Many Details"], ["HEALTH", "High Pressure Dave"], ["Neon Indian", "Change of Coast"],
      ["Little Dragon", "Crystalfilm"], ["Feathers", "Dark Matter"], ["Chad Valley", "Shell Suite"], ["Poolside", "Do You Believe"],
      ["Miami Horror", "Sometimes"], ["Small Black", "Free at Dawn"], ["Age of Consent", "Colours"], ["Favored Nations", "The Setup"],
    ],
  },
  {
    id: "v-east-los", era: "v", name: "East Los FM", genre: "Mexican, cumbia, rock en español", vibe: "Barrio block party", host: "DJ Camilo & Don Cheto",
    colors: ["#2fbf71", "#d71921"], monogram: "ELS",
    songs: [
      ["Maldita Vecindad", "Pachuco"], ["Mexican Institute of Sound", "México"], ["Hechizeros Band", "El Sonidito"],
      ["Niña Dioz", "Criminal Style"], ["Fandango", "Autos, Moda y Rock and Roll"], ["La Sonora Dinamita", "Se Me Perdió La Cadenita"],
    ],
  },
  {
    id: "v-ifruit", era: "v", name: "iFruit Radio", genre: "Hip-hop & R&B", vibe: "Fresh off the phone", host: "Danny Brown",
    colors: ["#ff6b4a", "#ffffff"], monogram: "iF",
    songs: [["Tyler, The Creator", "Earfquake"], ["Danny Brown", "Dirty Laundry"], ["Megan Thee Stallion", "Realer"], ["Freddie Gibbs Madlib", "Crime Pays"]],
  },
  {
    id: "v-blonded", era: "v", name: "blonded Los Santos", freq: "97.8", genre: "Alt R&B", vibe: "Hazy, curated, drifting", host: "Frank Ocean",
    colors: ["#ff8a3d", "#fff4e0"], monogram: "BLD",
    songs: [["Frank Ocean", "Provider"], ["Frank Ocean", "Chanel"], ["Frank Ocean", "Biking"]],
  },

  // ---- Vice City '86 ----------------------------------------------------------------
  {
    id: "vc-flash-fm", era: "vc", name: "Flash FM", genre: "'80s pop", vibe: "Ocean Drive on a Friday night", host: "Toni",
    colors: ["#ff3e9a", "#ffd166"], monogram: "FL",
    songs: [
      ["Michael Jackson", "Billie Jean"], ["Hall & Oates", "Out of Touch"], ["Laura Branigan", "Self Control"], ["Joe Jackson", "Steppin' Out"],
      ["Kim Wilde", "Kids in America"], ["Aneka", "Japanese Boy"], ["Bryan Adams", "Run to You"], ["Wang Chung", "Dance Hall Days"],
      ["The Buggles", "Video Killed the Radio Star"], ["Lionel Richie", "Running with the Night"], ["Electric Light Orchestra", "Four Little Diamonds"],
      ["Talk Talk", "Life's What You Make It"], ["Jan Hammer", "Crockett's Theme"],
    ],
  },
  {
    id: "vc-v-rock", era: "vc", name: "V-Rock", genre: "'80s hard rock & metal", vibe: "Hairspray and power chords", host: "Lazlow",
    colors: ["#d71921", "#ffd166"], monogram: "VR",
    songs: [
      ["Iron Maiden", "2 Minutes to Midnight"], ["Megadeth", "Peace Sells"], ["Ozzy Osbourne", "Bark at the Moon"],
      ["Mötley Crüe", "Too Young to Fall in Love"], ["Judas Priest", "Electric Eye"], ["Def Leppard", "Rock of Ages"],
      ["Quiet Riot", "Cum On Feel the Noize"], ["Twisted Sister", "I Wanna Rock"], ["Slayer", "Raining Blood"], ["Anthrax", "Madhouse"],
      ["Loverboy", "Working for the Weekend"], ["Autograph", "Turn Up the Radio"],
    ],
  },
  {
    id: "vc-fever-105", era: "vc", name: "Fever", freq: "105", genre: "Disco, funk & soul", vibe: "Mirror balls and white suits", host: "Oliver \"Ollie\" Biscuit",
    colors: ["#ffd166", "#6a3fb5"], monogram: "FEV",
    songs: [
      ["Kool & the Gang", "Summer Madness"], ["The Pointer Sisters", "Automatic"], ["Rick James", "Ghetto Life"], ["Mary Jane Girls", "All Night Long"],
      ["Teena Marie", "Behind the Groove"], ["Fat Larry's Band", "Act Like You Know"], ["Mtume", "Juicy Fruit"],
      ["Indeep", "Last Night a DJ Saved My Life"], ["René & Angela", "I'll Be Good"], ["Oliver Cheatham", "Get Down Saturday Night"],
    ],
  },
  {
    id: "vc-wildstyle", era: "vc", name: "Wildstyle", genre: "Early hip-hop & electro", vibe: "Breakbeats on the boardwalk", host: "Mr. Magic",
    colors: ["#19d3c5", "#1a0b2e"], monogram: "WS",
    songs: [
      ["Grandmaster Flash and the Furious Five", "The Message"], ["Run-DMC", "Rock Box"], ["Afrika Bambaataa", "Planet Rock"],
      ["Herbie Hancock", "Rockit"], ["Whodini", "Magic's Wand"], ["Cybotron", "Clear"], ["Hashim", "Al-Naafiysh (The Soul)"],
      ["Mantronix", "Bassline"], ["Trouble Funk", "Pump Me Up"], ["Davy DMX", "One for the Treble"], ["Zapp", "More Bounce to the Ounce"],
      ["Man Parrish", "Hip Hop, Be Bop (Don't Stop)"],
    ],
  },
  {
    id: "vc-emotion", era: "vc", name: "Emotion", freq: "98.3", genre: "Soft rock & power ballads", vibe: "Moonlight on Starfish Island", host: "Fernando Martinez",
    colors: ["#ff5fa8", "#14213d"], monogram: "EM",
    songs: [
      ["Roxette", "Listen to Your Heart"], ["REO Speedwagon", "Keep On Loving You"], ["Mr. Mister", "Broken Wings"], ["Kate Bush", "Wow"],
      ["Foreigner", "Waiting for a Girl Like You"], ["Toto", "Africa"], ["Cutting Crew", "(I Just) Died in Your Arms"], ["Squeeze", "Tempted"],
      ["Night Ranger", "Sister Christian"], ["Luther Vandross", "Never Too Much"],
    ],
  },
  {
    id: "vc-wave-103", era: "vc", name: "Wave", freq: "103", genre: "New wave & synth-pop", vibe: "Sunglasses at night, literally", host: "Adam First",
    colors: ["#3fe0f0", "#ff3e9a"], monogram: "WV",
    songs: [
      ["A Flock of Seagulls", "I Ran (So Far Away)"], ["Frankie Goes to Hollywood", "Two Tribes"], ["Tears for Fears", "Pale Shelter"],
      ["Gary Numan", "Cars"], ["Blondie", "Atomic"], ["Nena", "99 Luftballons"], ["The Human League", "(Keep Feeling) Fascination"],
      ["Romeo Void", "Never Say Never"], ["Soft Cell", "Sex Dwarf"], ["ABC", "Poison Arrow"], ["Martha and the Muffins", "Echo Beach"],
      ["Corey Hart", "Sunglasses at Night"], ["The Psychedelic Furs", "Love My Way"], ["Animotion", "Obsession"],
    ],
  },
  {
    id: "vc-espantoso", era: "vc", name: "Radio Espantoso", genre: "Latin jazz, salsa & mambo", vibe: "Mambo in Little Havana", host: "Pepe",
    colors: ["#ff8a3d", "#2a0716"], monogram: "ESP",
    songs: [["Deodato", "Latin Flute"], ["Tito Puente", "Mambo Gozón"], ["Mongo Santamaría", "Mayeya"], ["Irakere", "Añunañu"]],
  },
]

export const stationsForEra = (era: RadioEra) => RADIO_STATIONS.filter((s) => s.era === era)

export const findStation = (id: string | null | undefined) =>
  id ? RADIO_STATIONS.find((s) => s.id === id) ?? null : null

/** "Flash FM" + "98.3" → "Flash FM 98.3" */
export const stationTitle = (s: RadioStation) => (s.freq ? `${s.name} ${s.freq}` : s.name)
