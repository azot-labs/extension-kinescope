import { defineExtension } from "azot";

const KINESCOPE_MASTER_PLAYLIST_URL = "https://kinescope.io/{video_id}/master.mpd";
const DEFAULT_REFERER = "https://kinescope.io/";
const DRM_HEADERS = {
  Accept: "*/*",
  "Accept-Language": "en-AU,en-GB;q=0.9,en-US;q=0.8,en;q=0.7",
  Origin: "https://kinescope.io",
  Referer: DEFAULT_REFERER,
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
};

/**
 * Widevine example on a third-party service:
 * Page: https://nd.umschool.net/lesson/38700
 * Command: streamyx 'https://kinescope.io/2najSKQJAUAAdJQXqdN6xG?v=2.150.1&enableIframeApi&playerId=video_frame_https_kinescope_io_2_naj_skqjaua_ad_jq_xqd_n_6_x_g&size%5Bwidth%5D=100%25&size%5Bheight%5D=100%25&behaviour%5BautoPlay%5D==true' -H 'referer: https://nd.umschool.net/'
 *
 * Widevine examples:
 * Command: streamyx https://kinescope.io/200660125
 * Command: streamyx https://kinescope.io/201265440
 *
 * ClearKey examples:
 * Command: streamyx https://kinescope.io/201268665
 * Command: streamyx https://kinescope.io/embed/202544377
 */

const getReferer = async (headers) => {
  const referer = headers.referer || headers.Referer;
  if (referer) return referer;
  const response = await prompt("Enter the website where the Kinescope player is located", {
    form: {
      referer: {
        type: "text",
        title: "Referer",
        autoFocus: true,
      },
    },
  });
  return `${new URL(response.referer ?? DEFAULT_REFERER).origin}/`;
};

export default defineExtension({
  async getEntries({ url, options: args }) {
    const headers = args.header;
    const referer = await getReferer(headers);
    const response = await fetch(url, { headers: { referer } });
    const data = await response.text();

    const title = data.split("<title>")[1]?.split("</title>")[0];
    const playerOptionsString = data.split("playerOptions = ")[1]?.split("};")[0] + "}";
    const playerOptions = eval(`(${playerOptionsString})`);

    if (!playerOptions?.playlist) return [];

    const selectedEpisodes = Array.from(args.episodes?.values() ?? []).flatMap((seasonEpisodes) =>
      Array.from(seasonEpisodes.values()),
    );
    const results = [];
    const playlists = playerOptions.playlist ?? [];

    for (const [index, playlist] of playlists.entries()) {
      const clearkey = playlist.drm?.clearkey;
      const widevine = playlist.drm?.widevine;
      const episodeNumber = index + 1;
      if (selectedEpisodes.length && !selectedEpisodes.includes(episodeNumber)) continue;

      const id =
        playlist.id || (data.includes('id: "') ? data.split('id: "')[1].split('"')[0] : undefined);
      const sourceUrl = playlist.sources.shakadash?.src || playlist.sources.shakahls?.src;
      const { searchParams } = new URL(sourceUrl);
      const masterUrl = `${KINESCOPE_MASTER_PLAYLIST_URL.replace("{video_id}", id)}?${searchParams.toString()}`;
      const manifestUrl = id ? masterUrl : sourceUrl;
      const context = {};

      if (widevine) {
        context.drmServer = widevine.licenseUrl;
      } else if (clearkey) {
        const manifest = await fetch(manifestUrl).then((manifestResponse) =>
          manifestResponse.text(),
        );
        const kid = manifest.split('default_KID="')[1]?.split('"')[0]?.replaceAll("-", "");
        if (!kid) {
          console.error("KID not found");
          return [];
        }
        const encodedKid = Uint8Array.fromHex(kid).toBase64().replaceAll("=", "");
        const clearkeyResponse = await fetch(clearkey.licenseUrl, {
          method: "POST",
          headers: { Referer: DEFAULT_REFERER },
          body: JSON.stringify({ kids: [encodedKid], type: "temporary" }),
        }).then((licenseResponse) => licenseResponse.json());
        const encodedKey = clearkeyResponse.keys?.[0]?.k;
        if (!encodedKey) {
          console.error("ClearKey response is missing a decryption key");
          return [];
        }
        const key = Uint8Array.fromBase64(encodedKey + "==").toHex();
        context.keys = [{ kid, key }];
      }

      results.push({
        id,
        type: selectedEpisodes.length || playlists.length > 1 ? "episode" : "video",
        title: playlist.title || title,
        episodeNumber: playlists.length > 1 ? episodeNumber : undefined,
        source: {
          url: manifestUrl,
          headers,
        },
        context,
      });
    }

    return results;
  },

  drm: {
    async requestLicense(request) {
      if (request.system !== "widevine") {
        throw new Error(`Unsupported DRM system: ${request.system}`);
      }

      const drmServer = request.resource.entry.context?.drmServer;
      if (!drmServer) {
        throw new Error("Kinescope DRM server is missing on the resolved entry");
      }

      const response = await fetch(drmServer, {
        method: "POST",
        headers: DRM_HEADERS,
        body: request.data,
      });
      return new Uint8Array(await response.arrayBuffer());
    },

    async resolveKeys(request) {
      if (request.system !== "clearkey") {
        return [];
      }
      return request.resource.entry.context?.keys ?? [];
    },
  },
});
