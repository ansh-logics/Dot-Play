export interface PublicVideoMetadata {
  title: string
  authorName: string
  thumbnailUrl: string
}

export function extractVideoId(value: string): string | null {
  const input = value.trim()
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input

  try {
    const url = new URL(input)
    const host = url.hostname.replace(/^www\./, "")

    if (host === "youtu.be") return url.pathname.slice(1).split("/")[0] || null
    if (host.endsWith("youtube.com")) {
      const videoId = url.searchParams.get("v")
        ?? url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1]
      return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : null
    }
  } catch {
    return null
  }

  return null
}

export async function fetchPublicVideoMetadata(videoId: string): Promise<PublicVideoMetadata> {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  const response = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
  )

  if (!response.ok) {
    throw new Error("This video is unavailable, private, or no longer exists.")
  }

  const data = await response.json() as {
    author_name?: string
    thumbnail_url?: string
    title?: string
  }

  if (!data.title || !data.author_name || !data.thumbnail_url) {
    throw new Error("YouTube returned incomplete metadata for this video.")
  }

  return {
    title: data.title,
    authorName: data.author_name,
    thumbnailUrl: data.thumbnail_url,
  }
}
