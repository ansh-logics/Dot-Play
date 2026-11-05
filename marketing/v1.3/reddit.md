# Reddit: Cassette mode + Phone Remote (v1.3)

**Format:** image gallery: images/x-cassette.jpg, x-remote.jpg, then the raw shots
../../site/public/shots/app-cassette.jpg, remote-playing.jpg, remote-search.jpg. Gallery captions are below.

**Where:**
- r/macapps (say you're the developer; they require it)
- r/YoutubeMusic
- r/windowsapps
- r/SideProject

Read each sub's self-promotion rules first. Post to one or two subs a day, not all at once: Reddit treats
the same link everywhere at once as spam. For r/SideProject, lead with the relay story (body B).

## Title options

1. I turned my YouTube Music app into a cassette deck, and made my phone the remote (free, Mac & Windows)
2. My YouTube Music player now has a full cassette deck mode. The reels actually wind as the song plays 📼
3. Update: dot(.)music 1.3 adds a cassette deck and a phone remote that works on any network
4. (r/SideProject) My phone remote didn't work on my own Wi-Fi, so I rebuilt it on an encrypted relay

## Body A (r/macapps, r/YoutubeMusic, r/windowsapps)

Hi! I'm the developer of dot(.)music, a free YouTube Music player for Mac and Windows. Version 1.3 has the two
things people asked about most:

**📼 Cassette mode**

The whole Now Playing screen becomes a hi-fi tape deck:

- Your album cover on the tape label, with the title handwritten
- The reels wind from one side to the other as the song plays, and fast-wind when you seek
- Rew, Play, Pause and FF piano keys that latch, a real Eject, a volume fader and a tape counter
- Synced lyrics on an amber phosphor screen
- Optional key clicks and motor sounds (off in Settings if you just want the look)

It's one of four styles (Apple, Nothing, Vinyl, Cassette). Turn the wheel at the edge of the player to switch.

**📱 Phone Remote**

Settings → Phone Remote, scan the QR code, and your phone's browser becomes a remote:

- Play, skip, seek, volume, live lyrics, Up Next (drag to reorder) and search
- Works on **any network**: home Wi-Fi, office Wi-Fi or mobile data. No router settings, no app to install.
- End-to-end encrypted. Your computer asks before a new phone can connect, and you can disconnect it any time.

Also new: import playlists from Spotify, Apple Music or Deezer, and lyrics that fall back to plain text when the
timing is wrong instead of jumping around.

👉 **Download (free):** https://dot-play-seven.vercel.app

Apple Silicon Macs and 64-bit Windows 10/11. I read every comment, so tell me what's broken or what you'd like
next.

*Not affiliated with YouTube or Google. Playback runs through YouTube, so nothing is downloaded or pirated.*

## Body B (r/SideProject: the build story)

I make a free YouTube Music player, and I shipped a phone remote. It worked on my desk, then failed on my own
Wi-Fi: the router blocked my phone from connecting to my laptop. Many home, office and college networks do the
same, and "change your router settings" isn't a real answer.

So I rebuilt it:

- The phone and the computer both connect **out** to a small relay on Cloudflare Workers (one Durable Object per
  computer). Outgoing connections work almost everywhere, including mobile data.
- Everything is **end-to-end encrypted** with AES-GCM. The relay routes scrambled bytes and can't read a thing.
- Pairing is a QR code whose secret sits in the URL's `#fragment`, which browsers never send to a server. Each
  code pairs exactly one phone, and the computer asks "Allow?" first.
- Idle rooms hibernate, so it fits comfortably in Cloudflare's free tier.

The other new thing is a cassette deck mode, the most-loved thing I've built (screenshots in the gallery).

Tauri + Rust + React. Free for Mac and Windows: https://dot-play-seven.vercel.app
Code: https://github.com/ansh-logics/Dot-Play

Happy to answer anything about the relay or the encryption.

## Gallery captions

1. Cassette mode: the whole player becomes a hi-fi tape deck
2. Your phone is the remote: any network, nothing to install
3. The deck up close: reels, piano keys, tape counter and an amber lyrics screen
4. The remote's Now Playing
5. Search from your phone: play now, play next or add to Up Next
