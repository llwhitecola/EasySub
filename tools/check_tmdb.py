"""Offline regression checks for TMDB discovery and subtitle translation context."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import _build_trans_cfg
from core import tmdb


def main() -> None:
    episode = tmdb.parse_media_name(r"C:\Videos\[Group] Example.Show.S02E03.1080p.WEB-DL.mkv")
    assert episode == {"title": "Example Show", "year": None, "season": 2, "episode": 3, "multiple": False}
    assert tmdb.parse_media_name("Example.Show.S02E03-E04.mkv")["multiple"]
    assert tmdb.parse_media_name("片名 第2季第3集.ass")["episode"] == 3
    assert tmdb.parse_media_name("Blade.Runner.2049.mkv")["title"] == "Blade Runner 2049"
    assert tmdb.parse_media_name("Example.Film.(2024).1080p.en.srt")["year"] == 2024

    def api(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer fixture.token.signature"
        path = request.url.path
        query = request.url.params.get("query")
        assert request.url.host == "api.themoviedb.org"
        assert not query or ("\\" not in query and "/" not in query)
        if query == "Access Error":
            return httpx.Response(401, json={"status_message": "Private response"})
        if path == "/3/search/multi":
            return httpx.Response(200, json={"total_pages": 1, "results": [
                {"id": 1, "media_type": "movie", "title": "同名影片", "original_title": "Example Film", "release_date": "1980-01-01"},
                {"id": 2, "media_type": "movie", "title": "同名影片", "original_title": "Example Film", "release_date": "2024-01-01"},
                {"id": 3, "media_type": "person", "name": "Example Film"},
            ]})
        if path == "/3/search/tv":
            assert query == "Example Show"
            return httpx.Response(200, json={"total_pages": 1, "results": [
                {"id": 123, "name": "示例剧集", "original_name": "Example Show", "first_air_date": "2020-01-01"},
            ]})
        if path == "/3/tv/123":
            return httpx.Response(200, json={
                "name": "示例剧集", "original_name": "Example Show", "first_air_date": "2020-01-01",
                "overview": "整个系列的故事。", "external_ids": {"wikidata_id": "Q123"},
                "credits": {"cast": [{"name": "Actor 1", "character": "Series Lead"}]},
            })
        if path == "/3/tv/123/season/2/episode/3":
            if request.url.params.get("language") == "en-US":
                return httpx.Response(200, json={"overview": "Episode three summary."})
            return httpx.Response(200, json={
                "name": "第三集", "guest_stars": [{"name": "Actor 2", "character": "Guest Lead"}],
                "external_ids": {"imdb_id": "tt1234567", "tvdb_id": 443},
            })
        raise AssertionError(f"Unexpected path {path}")

    original_client = httpx.Client
    transport = httpx.MockTransport(api)
    credential = "fixture.token.signature"
    wikidata = httpx.Response(200, json={
        "entities": {"Q123": {"labels": {"zh": {"value": "另一译名"}}, "aliases": {}}}
    }, request=httpx.Request("GET", "https://www.wikidata.org/w/api.php"))
    with (
        patch.object(tmdb.httpx, "Client", side_effect=lambda **opts: original_client(transport=transport, **opts)),
        patch.object(tmdb.httpx, "get", return_value=wikidata) as wiki_request,
    ):
        ambiguous = tmdb.search_media(credential, "Example.Film.mkv")
        assert ambiguous["match"] is None and len(ambiguous["candidates"]) == 2
        movie = tmdb.search_media(credential, "Example.Film.2024.mkv")
        assert movie["match"]["id"] == 2
        match = tmdb.search_media(credential, "Example.Show.S02E03.srt")["match"]
        assert match["episode"] == 3 and match["kind"] == "tv"
        assert tmdb.search_media(credential, "Example.Show.S02E03E04.srt")["match"] is None
        meta = tmdb.load_metadata(credential, match)
        assert meta["episode_overview"] == "Episode three summary."
        assert meta["roles"][0]["character"] == "Guest Lead" and len(meta["roles"]) == 2
        assert meta["aliases"] == ["另一译名"] and meta["external_ids"]["episode"]["imdb_id"] == "tt1234567"
        assert credential not in str(wiki_request.call_args)
        try:
            tmdb.search_media(credential, "Access Error", filename=False)
        except tmdb.TmdbError as exc:
            assert "401" not in str(exc) and credential not in str(exc)
        else:
            raise AssertionError("Expected a credential error")

    settings = {"trans_provider": "llm", "trans_context": "保留我的影片笔记", "trans_glossary": "Series Lead=固定译名"}
    cfg = _build_trans_cfg(settings, meta)
    assert cfg["glossary"] == settings["trans_glossary"]
    assert all(x in cfg["story_context"] for x in ("保留我的影片笔记", "S02E03", "Guest Lead", "另一译名"))
    assert credential not in cfg["story_context"]
    assert _build_trans_cfg({**settings, "trans_provider": "free"}, meta)["story_context"] == settings["trans_context"]
    print("TMDB filename parsing, ambiguous titles, episode metadata, Wikidata aliases and translation context passed")


if __name__ == "__main__":
    main()
