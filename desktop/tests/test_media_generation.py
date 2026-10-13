"""Bounded media jobs: no real provider, paid job, or local model is started."""
from __future__ import annotations
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import shutil
import subprocess
import unittest
import uuid
from unittest.mock import patch

from PIL import Image
from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry.media_store import MediaCommitMixin
from foundry.media_contracts import AUTHORITY, endpoint, request, validate_candidate
from foundry.media_execution import dispatch
from foundry.media_provider import ComfyMedia
from foundry.media_workflows import build, catalog

Store = CommitService if issubclass(CommitService, MediaCommitMixin) else type("IntegratedTestStore", (MediaCommitMixin, CommitService), {})


def png(width=256, height=256):
    out = io.BytesIO()
    Image.new("RGB", (width, height), (28, 43, 61)).save(out, "PNG")
    return out.getvalue()


class FakeProvider:
    def __init__(self):
        self.posts = []
        self.uploads = []
        self.remotes = {}
        self.ambiguous = False
        self.cancel_calls = []
        self.output_bytes = png()

    def health(self, graphs):
        return {"ready": True, "missing": []}

    def upload(self, raw, validation, job_id):
        self.uploads.append(job_id)
        return "yur-" + job_id + ".png"

    def submit(self, graph, job_id, sha):
        self.posts.append((job_id, sha, graph))
        self.remotes[job_id] = {"sha": sha, "prompt_id": "remote-" + job_id, "state": "queued"}
        if self.ambiguous:
            raise TimeoutError("Provider response timed out")
        return self.remotes[job_id]["prompt_id"]

    def reconcile(self, job_id, sha):
        entry = self.remotes.get(job_id)
        return entry["prompt_id"] if entry and entry["sha"] == sha else None

    def inspect(self, prompt_id):
        remote = next(value for value in self.remotes.values() if value["prompt_id"] == prompt_id)
        return {"state": remote["state"]}

    def outputs(self, remote, output_node, job_id, kind):
        return [{"bytes": self.output_bytes, "remote": {"filename": job_id + "_00001_.png", "subfolder": "yur-desktop", "type": "output"}}]

    def cancel_queued(self, prompt_id):
        self.cancel_calls.append(prompt_id)
        remote = next(value for value in self.remotes.values() if value["prompt_id"] == prompt_id)
        return {"cancelled": remote["state"] == "queued", "notice": "Only owned queued jobs are removable"}


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "state")
        self.manager = OrchestrationManager(self.store)
        self.provider = FakeProvider()
        self.call("configure", {"endpoint": "https://media.example.test"})

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def call(self, action, payload=None, envelope=AUTHORITY):
        return dispatch(self.manager, action, payload, envelope=envelope, provider_factory=lambda url: self.provider)

    def req(self, **values):
        return {"request_id": str(uuid.uuid4()), "preset": "flux-klein-image-v1", "prompt": "Blue slate sculpture", "width": 256, "height": 256, **values}

    def test_explicit_authority_and_unknown_fields_rejected_before_provider(self):
        with self.assertRaises(PermissionError):
            self.call("submit", {"request": self.req()}, envelope={})
        with self.assertRaises(ValueError):
            self.call("submit", {"request": self.req(), "graph": {}})
        self.assertEqual([], self.provider.posts)

    def test_submit_is_idempotent_and_resume_commits_decoded_exact_bytes(self):
        request_value = self.req()
        first = self.call("submit", {"request": request_value})
        second = self.call("submit", {"request": request_value})
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(1, len(self.provider.posts))
        self.assertEqual("queued", first["state"])
        self.provider.remotes[first["id"]]["state"] = "ready"
        completed = self.call("resume", {"job_id": first["id"]})
        self.assertEqual("completed", completed["state"])
        asset = completed["assets"][0]
        self.assertEqual(hashlib.sha256(png()).hexdigest(), asset["id"])
        materialized = self.call("asset", {"asset_id": asset["id"]})
        self.assertEqual(png(), Path(materialized["path"]).read_bytes())
        self.assertTrue(self.store.verify_media()["ok"])
        self.assertLess(len(json.dumps(completed)), 5000)
        self.assertNotIn("base64", json.dumps(completed))
        self.assertEqual(completed, self.call("resume", {"job_id": first["id"]}))

    def test_reused_request_with_other_prompt_is_rejected(self):
        req = self.req()
        self.call("submit", {"request": req})
        with self.assertRaisesRegex(ValueError, "different input"):
            self.call("submit", {"request": {**req, "prompt": "changed"}})
        self.assertEqual(1, len(self.provider.posts))

    def test_ambiguous_post_recovers_remote_id_and_never_posts_again(self):
        self.provider.ambiguous = True
        req = self.req()
        first = self.call("submit", {"request": req})
        self.assertEqual("submission_unknown", first["state"])
        self.assertIsNone(first["receipt"])
        self.call("submit", {"request": req})
        self.store.close()
        self.store = Store(Path(self.temp.name) / "state")
        self.manager = OrchestrationManager(self.store)
        recovered = self.call("resume", {"job_id": first["id"]})
        self.assertEqual("queued", recovered["state"])
        self.assertEqual("remote-" + first["id"], recovered["receipt"]["prompt_id"])
        self.assertEqual(1, len(self.provider.posts))

    def test_ambiguous_missing_history_is_preserved_without_resubmission(self):
        self.provider.ambiguous = True
        first = self.call("submit", {"request": self.req()})
        self.provider.remotes.clear()
        result = self.call("resume", {"job_id": first["id"]})
        self.assertEqual("submission_unknown", result["state"])
        self.assertEqual(1, len(self.provider.posts))

    def test_validation_failure_never_commits_or_materializes_asset(self):
        first = self.call("submit", {"request": self.req()})
        self.provider.remotes[first["id"]]["state"] = "ready"
        self.provider.output_bytes = b"<html>not an image</html>"
        result = self.call("resume", {"job_id": first["id"]})
        self.assertEqual("failed", result["state"])
        self.assertEqual([], result["assets"])
        self.assertEqual(0, self.store._db.execute("SELECT COUNT(*) FROM media_blobs").fetchone()[0])

    def test_dimension_mismatch_fails_validation(self):
        first = self.call("submit", {"request": self.req()})
        self.provider.remotes[first["id"]]["state"] = "ready"
        self.provider.output_bytes = png(512, 256)
        result = self.call("resume", {"job_id": first["id"]})
        self.assertEqual("failed", result["state"])
        self.assertIn("dimensions", result["error"])

    def test_interrupted_output_transfer_resumes_without_another_generation(self):
        job = self.call("submit", {"request": self.req()})
        self.provider.remotes[job["id"]]["state"] = "ready"
        with patch.object(self.provider, "outputs", side_effect=TimeoutError("download interrupted")):
            interrupted = self.call("resume", {"job_id": job["id"]})
        self.assertEqual("validating", interrupted["state"])
        completed = self.call("resume", {"job_id": job["id"]})
        self.assertEqual("completed", completed["state"])
        self.assertEqual(1, len(self.provider.posts))

    def test_binary_commit_cannot_use_a_receipt_for_different_bytes(self):
        validation = validate_candidate(png(), "image")
        with self.assertRaisesRegex(ValueError, "exact bytes"):
            self.store.media_commit_blob(png(512, 256), validation, AUTHORITY, origin={})

    def test_only_own_queued_receipt_can_be_cancelled(self):
        first = self.call("submit", {"request": self.req()})
        self.provider.remotes[first["id"]]["state"] = "running"
        result = self.call("cancel", {"job_id": first["id"]})
        self.assertNotEqual("cancelled", result["state"])
        self.provider.remotes[first["id"]]["state"] = "queued"
        result = self.call("cancel", {"job_id": first["id"]})
        self.assertEqual("cancelled", result["state"])
        self.assertEqual([first["receipt"]["prompt_id"]] * 2, self.provider.cancel_calls)

    def test_video_requires_committed_starting_image_and_cannot_inject_graph(self):
        with self.assertRaisesRegex(ValueError, "starting image"):
            request(self.req(preset="wan22-video-v1"))
        path = Path(self.temp.name) / "input.png"
        path.write_bytes(png())
        asset = self.call("import", {"path": str(path)})
        req = self.req(preset="wan22-video-v1", input_asset_id=asset["id"])
        job = self.call("submit", {"request": req})
        self.assertEqual("queued", job["state"])
        graph = self.provider.posts[0][2]
        self.assertEqual("Wan22ImageToVideoLatent", graph["7"]["class_type"])
        self.assertEqual("yur-" + job["id"] + ".png", graph["20"]["inputs"]["image"])
        with self.assertRaises(ValueError):
            request({**req, "graph": graph})

    def test_graph_is_deterministic_and_presets_have_provenance(self):
        req = self.req()
        self.assertEqual(build(req, "a" * 32), build(req, "a" * 32))
        self.assertNotIn("30", build(req, "a" * 32))
        edit = build({**req, "input_asset_id": "b" * 64}, "a" * 32, "safe.png")
        self.assertEqual("ReferenceLatent", edit["33"]["class_type"])
        self.assertEqual(2, len(catalog()["presets"]))
        for preset in catalog()["presets"]:
            self.assertEqual(64, len(preset["template_sha256"]))

    def test_mutating_job_or_config_without_event_is_detected(self):
        first = self.call("submit", {"request": self.req()})
        self.store._db.execute("UPDATE media_jobs SET document=? WHERE id=?", ('{}', first["id"]))
        with self.assertRaisesRegex(ValueError, "job/event"):
            self.store.verify_media()

    def test_configuration_change_does_not_repoint_existing_job(self):
        first = self.call("submit", {"request": self.req()})
        self.call("configure", {"endpoint": "https://next-pod.example.test"})
        self.assertEqual("https://media.example.test", self.call("inspect", {"job_id": first["id"]})["provider"]["endpoint"])

    # It encodes a short H.264 clip with ffmpeg on this computer, so it runs only when asked for
    # (YUR_TEST_LOCAL_FFMPEG=1): the owner's machines run no local transcodes by default.
    @unittest.skipUnless(os.environ.get("YUR_TEST_LOCAL_FFMPEG") == "1" and shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "Local video encode is opt-in (YUR_TEST_LOCAL_FFMPEG=1), or the video decoder dependencies are unavailable")
    def test_video_output_is_probed_decoded_and_committed_after_validation(self):
        image = Path(self.temp.name) / "input.png"
        image.write_bytes(png())
        imported = self.call("import", {"path": str(image)})
        output = Path(self.temp.name) / "candidate.mp4"
        subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=navy:s=256x256:r=24", "-frames:v", "17", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(output)], check=True, capture_output=True, timeout=20)
        self.provider.output_bytes = output.read_bytes()
        job = self.call("submit", {"request": self.req(preset="wan22-video-v1", input_asset_id=imported["id"], frames=17)})
        self.provider.remotes[job["id"]]["state"] = "ready"
        completed = self.call("resume", {"job_id": job["id"]})
        self.assertEqual("completed", completed["state"], completed["error"])
        self.assertEqual("video/mp4", completed["assets"][0]["mime"])
        self.assertIn("first-frame-decode", completed["assets"][0]["checks"])
        with self.assertRaises(ValueError):
            validate_candidate(b"not-an-mp4", "video")


class ProviderBoundaryTests(unittest.TestCase):
    def test_endpoint_contract(self):
        self.assertEqual("http://127.0.0.1:8188", endpoint("http://127.0.0.1:8188/"))
        for value in ("http://remote.example", "https://user:secret@example.test", "https://example.test/path", "https://example.test?token=secret", "file:///tmp/x"):
            with self.assertRaises(ValueError):
                endpoint(value)

    def test_remote_output_from_other_job_cannot_be_downloaded(self):
        provider = ComfyMedia("https://media.example.test")
        remote = {"outputs": {"13": {"images": [{"type": "output", "subfolder": "yur-desktop", "filename": "other-job_1.png"}]}}}
        with patch.object(provider, "exchange") as exchange:
            with self.assertRaisesRegex(ValueError, "does not belong"):
                provider.outputs(remote, "13", "a" * 32, "image")
            exchange.assert_not_called()

    def test_running_cancel_never_calls_global_interrupt(self):
        provider = ComfyMedia("https://media.example.test")
        with patch.object(provider, "inspect", return_value={"state": "running"}), patch.object(provider, "exchange") as exchange:
            result = provider.cancel_queued("own-prompt")
            self.assertFalse(result["cancelled"])
            exchange.assert_not_called()

    def test_reconciliation_uses_both_job_id_and_graph_hash(self):
        provider = ComfyMedia("https://media.example.test")
        row = [0, "owned-receipt", {}, {"yur_media_job": "a" * 32, "workflow_sha256": "b" * 64}]
        wrong = copy.deepcopy(row); wrong[1] = "foreign-receipt"; wrong[3]["workflow_sha256"] = "c" * 64
        with patch.object(provider, "exchange", side_effect=[{"queue_pending": [wrong, row]}, {}]):
            self.assertEqual("owned-receipt", provider.reconcile("a" * 32, "b" * 64))


class EndpointBindingTests(unittest.TestCase):
    """Selection and receipts use temporary state and fake execution cells only."""
    IMAGE = "https://image.example.test"
    VIDEO = "https://video.example.test"
    NEXT = "https://next.example.test"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.environment = patch.dict("os.environ", {}, clear=True)
        self.environment.start()
        self.store = Store(Path(self.temp.name) / "state")
        self.manager = OrchestrationManager(self.store)
        self.providers = {url: FakeProvider() for url in (self.IMAGE, self.VIDEO, self.NEXT)}
        self.selected = []

    def tearDown(self):
        self.store.close()
        self.environment.stop()
        self.temp.cleanup()

    def provider(self, url):
        self.selected.append(url)
        return self.providers[url]

    def call(self, action, payload=None, envelope=AUTHORITY):
        return dispatch(self.manager, action, payload, envelope=envelope, provider_factory=self.provider)

    def req(self, kind="image", **values):
        req = {"request_id": str(uuid.uuid4()), "preset": "flux-klein-image-v1" if kind == "image" else "wan22-video-v1",
               "prompt": "Use https://prompt.example.test as an artistic subject", "width": 256, "height": 256}
        if kind == "video":
            validation = validate_candidate(png(), "image")
            asset = self.store.media_commit_blob(png(), validation, AUTHORITY, origin={"kind": "endpoint-test"})
            req["input_asset_id"] = asset["id"]
        return {**req, **values}

    def test_independent_status_and_jobs_use_each_selected_endpoint(self):
        config = self.call("configure", {"image_endpoint": self.IMAGE, "video_endpoint": self.VIDEO})
        self.assertEqual("", config["endpoint"])
        self.assertEqual([], self.selected, "Configuration must not call a provider")
        status = self.call("status")
        self.assertEqual([self.IMAGE, self.VIDEO], self.selected)
        self.assertEqual([("image", self.IMAGE), ("video", self.VIDEO)], [(p["kind"], p["endpoint"]) for p in status["presets"]])
        image = self.call("submit", {"request": self.req()})
        video = self.call("submit", {"request": self.req("video")})
        for job, kind, url in ((image, "image", self.IMAGE), (video, "video", self.VIDEO)):
            self.assertEqual(url, job["provider"]["endpoint"])
            self.assertEqual(kind + "_endpoint", job["provider"]["binding"])
            self.assertEqual("media." + kind, job["provider"]["logical_service"])
            self.assertIn("operator-selected", job["provider"]["selection_reason"])
            self.assertEqual(1, len(self.providers[url].posts))
        self.assertEqual([video["id"]], self.providers[self.VIDEO].uploads)
        self.assertEqual([], self.providers[self.IMAGE].uploads)
        self.assertTrue(self.store.verify_media()["ok"])

    def test_partial_update_and_clear_preserve_other_kind_without_fallback(self):
        self.call("configure", {"endpoint": self.IMAGE})
        config = self.call("configure", {"video_endpoint": self.VIDEO})
        self.assertEqual(self.IMAGE, config["image_endpoint"])
        self.assertEqual(self.VIDEO, config["video_endpoint"])
        config = self.call("configure", {"image_endpoint": ""})
        self.assertEqual("", config["image_endpoint"])
        self.assertEqual(self.VIDEO, config["video_endpoint"])
        status = self.call("status")
        self.assertFalse(status["presets"][0]["ready"])
        self.assertTrue(status["presets"][1]["ready"])
        self.assertEqual([self.VIDEO], self.selected)
        with self.assertRaisesRegex(ValueError, "image endpoint"):
            self.call("submit", {"request": self.req()})
        self.assertEqual(0, len(self.store.media_list()))
        self.assertEqual([self.VIDEO], self.selected)

    def test_failed_kind_readiness_does_not_inherit_other_kinds_health(self):
        self.call("configure", {"image_endpoint": self.IMAGE, "video_endpoint": self.VIDEO})
        with patch.object(self.providers[self.VIDEO], "health", side_effect=ConnectionError("Video unavailable")):
            status = self.call("status")
        self.assertTrue(status["ready"])
        self.assertTrue(status["presets"][0]["ready"])
        self.assertFalse(status["presets"][1]["ready"])
        self.assertEqual("Video unavailable", status["presets"][1]["notice"])

    def test_legacy_configuration_and_existing_snapshot_are_read_without_rewrite(self):
        self.call("configure", {"endpoint": self.IMAGE})
        document = self.store._db.execute("SELECT document FROM media_configuration").fetchone()[0]
        self.assertEqual({"provider": "comfy-media", "endpoint": self.IMAGE}, json.loads(document))
        # This is the exact pre-existing legacy job provider schema.
        old, created = self.store.media_create(request(self.req()), json.loads(document), AUTHORITY)
        self.assertTrue(created)
        old = self.call("resume", {"job_id": old["id"]})
        head = self.store.verify_media()["head"]
        self.store.close()
        self.store = Store(Path(self.temp.name) / "state")
        self.manager = OrchestrationManager(self.store)
        self.store.initialize_media()
        self.assertEqual(head, self.store.verify_media()["head"])
        self.assertEqual(document, self.store._db.execute("SELECT document FROM media_configuration").fetchone()[0])
        self.assertEqual(self.IMAGE, self.store.media_configuration()["video_endpoint"])
        self.call("configure", {"image_endpoint": self.NEXT, "video_endpoint": self.VIDEO})
        self.assertEqual(json.loads(document), self.store.media_get(old["id"])["provider"])
        self.assertEqual("cancelled", self.call("cancel", {"job_id": old["id"]})["state"])
        self.assertEqual(self.IMAGE, self.selected[-1])

    def test_changed_or_cleared_binding_never_repoints_an_idempotent_job(self):
        self.call("configure", {"image_endpoint": self.IMAGE, "video_endpoint": self.VIDEO})
        req = self.req()
        old = self.call("submit", {"request": req})
        self.call("configure", {"image_endpoint": self.NEXT})
        new = self.call("submit", {"request": self.req()})
        self.assertEqual(self.NEXT, new["provider"]["endpoint"])
        self.call("configure", {"image_endpoint": ""})
        self.assertEqual(old["id"], self.call("submit", {"request": req})["id"])
        self.providers[self.IMAGE].remotes[old["id"]]["state"] = "ready"
        completed = self.call("resume", {"job_id": old["id"]})
        self.assertEqual("completed", completed["state"])
        self.assertEqual(self.IMAGE, self.selected[-1])
        self.assertEqual(1, len(self.providers[self.IMAGE].posts))
        self.assertEqual(1, len(self.providers[self.NEXT].posts))

    def test_restart_reconciles_ambiguous_receipt_on_original_kind_binding(self):
        self.call("configure", {"image_endpoint": self.IMAGE, "video_endpoint": self.VIDEO})
        self.providers[self.VIDEO].ambiguous = True
        req = self.req("video")
        old = self.call("submit", {"request": req})
        self.assertEqual("submission_unknown", old["state"])
        self.call("configure", {"video_endpoint": self.NEXT})
        self.store.close()
        self.store = Store(Path(self.temp.name) / "state")
        self.manager = OrchestrationManager(self.store)
        self.assertEqual(old["id"], self.call("submit", {"request": req})["id"])
        resumed = self.call("resume", {"job_id": old["id"]})
        self.assertEqual("queued", resumed["state"])
        self.assertEqual(self.VIDEO, self.selected[-1])
        self.assertEqual(1, len(self.providers[self.VIDEO].posts))
        self.assertEqual([], self.providers[self.NEXT].posts)

    def test_legacy_setter_rebinds_both_new_job_kinds_together(self):
        self.call("configure", {"image_endpoint": self.IMAGE, "video_endpoint": self.VIDEO})
        config = self.call("configure", {"endpoint": self.NEXT + "/"})
        self.assertEqual(self.NEXT, config["endpoint"])
        self.assertEqual(self.NEXT, config["image_endpoint"])
        self.assertEqual(self.NEXT, config["video_endpoint"])

    def test_environment_bindings_are_validated_and_saved_configuration_wins(self):
        with patch.dict("os.environ", {"YUR_MEDIA_COMFY_URL": self.IMAGE}):
            self.store.initialize_media()
            self.assertEqual(self.IMAGE, self.store.media_configuration()["video_endpoint"])
            with patch.dict("os.environ", {"YUR_MEDIA_VIDEO_COMFY_URL": self.VIDEO}):
                self.assertEqual(self.VIDEO, self.store.media_configuration()["video_endpoint"])
                self.assertEqual(self.IMAGE, self.store.media_configuration()["image_endpoint"])
            with patch.dict("os.environ", {"YUR_MEDIA_VIDEO_COMFY_URL": ""}):
                self.assertEqual("", self.store.media_configuration()["video_endpoint"])
            with patch.dict("os.environ", {"YUR_MEDIA_IMAGE_COMFY_URL": "http://remote.example.test"}):
                with self.assertRaises(ValueError):
                    self.call("status")
            self.call("configure", {"image_endpoint": self.NEXT})
        with patch.dict("os.environ", {"YUR_MEDIA_COMFY_URL": "http://invalid.example.test"}):
            self.assertEqual(self.NEXT, self.store.media_configuration()["image_endpoint"])
            self.assertEqual(self.IMAGE, self.store.media_configuration()["video_endpoint"])
        self.assertEqual([], self.selected)

    def test_invalid_or_unauthorized_bindings_never_emit_config_event(self):
        self.call("configure", {"image_endpoint": self.IMAGE, "video_endpoint": self.VIDEO})
        config = self.store.media_configuration()
        head = self.store.verify_media()["head"]
        for value in ({}, {"image_endpoint": None}, {"video_endpoint": 1}, {"endpoint": self.NEXT, "image_endpoint": self.IMAGE},
                      {"image_endpoint": "https://user:secret@example.test"}, {"video_endpoint": "https://example.test/path"},
                      {"video_endpoint": "https://example.test?token=secret"}, {"image_endpoint": "http://remote.example.test"},
                      {"image_endpoint": self.IMAGE, "token": "never-persist"}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.call("configure", value)
        with self.assertRaises(PermissionError):
            self.call("configure", {"image_endpoint": self.NEXT}, envelope={})
        self.assertEqual(config, self.store.media_configuration())
        self.assertEqual(head, self.store.verify_media()["head"])
        self.assertEqual([], self.selected)

    def test_explicit_complete_bindings_replace_invalid_ambient_config(self):
        with patch.dict("os.environ", {"YUR_MEDIA_COMFY_URL": "http://invalid.example.test"}):
            with self.assertRaises(ValueError):
                self.call("status")
            config = self.call("configure", {"image_endpoint": self.IMAGE, "video_endpoint": self.VIDEO})
        self.assertEqual(self.IMAGE, config["image_endpoint"])
        self.assertEqual(self.VIDEO, config["video_endpoint"])
        self.assertEqual([], self.selected)

    def test_configuration_change_without_matching_event_is_detected(self):
        self.call("configure", {"image_endpoint": self.IMAGE, "video_endpoint": self.VIDEO})
        altered = {**self.store.media_configuration(), "video_endpoint": self.NEXT}
        self.store._db.execute("UPDATE media_configuration SET document=?", (json.dumps(altered),))
        with self.assertRaisesRegex(ValueError, "configuration/event mismatch"):
            self.store.verify_media()

    def test_request_cannot_inject_a_kind_endpoint(self):
        self.call("configure", {"image_endpoint": self.IMAGE})
        with self.assertRaises(ValueError):
            self.call("submit", {"request": self.req(endpoint=self.NEXT)})
        self.assertEqual([], self.selected)


if __name__ == "__main__":
    unittest.main()
