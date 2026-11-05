# LinkedIn: Cassette mode + Phone Remote (v1.3)

**Format:** upload the five carousel images (images/ig-1.jpg … ig-5.jpg) as a multi-image post, or turn them into
one PDF and post it as a document, which LinkedIn shows as a swipeable carousel.
Put the link in the **first comment**; LinkedIn shows posts with outside links to fewer people.

## Post

My router broke my favourite feature. So I rebuilt it to work on any network.

I've been building dot(.)music, a free YouTube Music player for Mac and Windows. Two things shipped this week:

📼 **A cassette deck mode.** The whole player becomes a hi-fi tape deck. Your album art goes on the tape label,
the reels wind as the song plays, the piano keys latch, and lyrics glow on an amber screen. People who tried it
liked it more than any feature I've built, which taught me something: in a crowded category, personality is the
feature.

📱 **A phone remote.** The first version connected the phone to the computer over home Wi-Fi. Then I tested it
on my own network and it failed, because many routers block devices from talking to each other. Asking users to
change router settings was never going to work.

So the phone and the computer now both connect *out* to a tiny relay I run on Cloudflare (Durable Objects), and
the relay passes messages between them:

• Works on any Wi-Fi, office networks and even mobile data
• End-to-end encrypted (AES-GCM): the relay only ever sees scrambled bytes
• Pairing by QR code, with a one-time secret that never reaches a server
• Nothing to install on the phone; it's a web page

What I took from it: test on networks you don't control, and when a design asks users to change settings, change
the design.

Built with Tauri, Rust and React. Mac and Windows, free.

What would you want to control from your phone next? 👇

#buildinpublic #indiedev #productdesign #rust #cloudflare #webdev

## First comment

Try it (free, Mac and Windows): https://dot-play-seven.vercel.app
Code: https://github.com/ansh-logics/Dot-Play
