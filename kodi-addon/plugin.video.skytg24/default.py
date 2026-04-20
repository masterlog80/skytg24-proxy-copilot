# -*- coding: utf-8 -*-
"""
Sky TG24 Live – Kodi 21 (Omega) video plugin
=============================================
Plays the HLS live stream exposed by the skytg24-proxy-copilot service.

Entry points
------------
  plugin://plugin.video.skytg24/          → plays the stream directly (no submenu)
  plugin://plugin.video.skytg24/?action=play → resolves & plays the stream
"""

import sys
import urllib.parse

import xbmc          # noqa: F401 – imported for xbmc.log
import xbmcaddon
import xbmcgui
import xbmcplugin

# ---------------------------------------------------------------------------
# Addon bootstrap
# ---------------------------------------------------------------------------
_ADDON   = xbmcaddon.Addon()
_HANDLE  = int(sys.argv[1])          # plugin handle passed by Kodi
_BASE    = sys.argv[0]               # plugin:// base URL


def _stream_url() -> str:
    """Build the stream URL from add-on settings."""
    host = _ADDON.getSetting('proxy_host') or '192.168.10.245'
    port = _ADDON.getSetting('proxy_port') or '6443'
    return f'http://{host}:{port}/stream'


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------

def _root_listing() -> None:
    """Directly launch the stream without showing an intermediate listing."""
    _play_stream_direct()
    # Close the directory handle without displaying any items
    xbmcplugin.endOfDirectory(_HANDLE, succeeded=False)


def _build_stream_item() -> xbmcgui.ListItem:
    """Build a fully configured ListItem for the HLS stream."""
    url  = _stream_url()
    item = xbmcgui.ListItem(path=url)

    # Tell Kodi this is an HLS stream so it picks the right demuxer
    item.setMimeType('application/x-mpegURL')
    item.setContentLookup(False)

    # --- inputstream.adaptive (optional) ------------------------------------
    # On Android, Kodi 21 ships with InputStream Adaptive pre-installed.
    # Using it gives adaptive bitrate switching; fall back silently if it is
    # not available (Kodi will still play HLS natively via ExoPlayer).
    try:
        item.setProperty('inputstream', 'inputstream.adaptive')
        item.setProperty('inputstream.adaptive.manifest_type', 'hls')
    except (AttributeError, RuntimeError) as exc:
        xbmc.log(f'plugin.video.skytg24: inputstream.adaptive unavailable – {exc}', xbmc.LOGWARNING)
    # -----------------------------------------------------------------------

    return item


def _play_stream_direct() -> None:
    """Start playback immediately (used when the plugin is opened at the root)."""
    item = _build_stream_item()
    xbmc.Player().play(_stream_url(), item)


def _play_stream() -> None:
    """Resolve and hand the HLS stream URL back to Kodi (used via ?action=play)."""
    xbmcplugin.setResolvedUrl(_HANDLE, True, _build_stream_item())


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

def _router(params: dict) -> None:
    action = params.get('action')
    if action is None:
        _root_listing()
    elif action == 'play':
        _play_stream()
    else:
        msg = f'plugin.video.skytg24: unknown action {action!r}'
        xbmc.log(msg, xbmc.LOGERROR)
        xbmcgui.Dialog().notification(
            _ADDON.getAddonInfo('name'),
            f'Unknown action: {action}',
            xbmcgui.NOTIFICATION_ERROR,
        )


if __name__ == '__main__':
    # sys.argv[2] is the query string, e.g. "?action=play"
    _router(dict(urllib.parse.parse_qsl(urllib.parse.urlparse(sys.argv[2]).query)))
