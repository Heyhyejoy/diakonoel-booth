import React, { useEffect, useRef, useState } from "react";
import "./DiakonoelPhotobooth.css";

import { QRCodeCanvas } from "qrcode.react";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage, ensureAnonAuth } from "../firebase";

const CAPTURE_COUNT = 4;

const PHOTO_SLOTS = [
  { x: 57, y: 68, width: 885, height: 589 },
  { x: 57, y: 712, width: 885, height: 589 },
  { x: 57, y: 1356, width: 885, height: 589 },
  { x: 57, y: 1997, width: 885, height: 589 },
] as const;

const TEMPLATE_SRC = `${import.meta.env.BASE_URL}diakonoel-frame.png`;

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function makeFilename(date = new Date()) {
  const YYYY = date.getFullYear();
  const MM = pad2(date.getMonth() + 1);
  const DD = pad2(date.getDate());
  const HH = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `diakonoel-${YYYY}${MM}${DD}-${HH}${mm}${ss}.png`;
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const r = await fetch(dataUrl);
  return await r.blob();
}

/** Firebase Storage 업로드 후 다운로드 URL 반환 */
async function uploadStripToFirebase(dataUrl: string, filename: string) {
  await ensureAnonAuth();

  const blob = await dataUrlToBlob(dataUrl);

  const now = new Date();
  const folder = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(
    now.getDate()
  )}`;
  const path = `diakonoel/${folder}/${filename}`;

  const objectRef = ref(storage, path);
  await uploadBytes(objectRef, blob, { contentType: "image/png" });
  return await getDownloadURL(objectRef);
}

/** 슬롯에 이미지를 cover로 넣기 */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  slot: { x: number; y: number; width: number; height: number }
) {
  const { x, y, width, height } = slot;

  const imgW = img.naturalWidth || img.width;
  const imgH = img.naturalHeight || img.height;

  const imgRatio = imgW / imgH;
  const slotRatio = width / height;

  let sx = 0,
    sy = 0,
    sWidth = imgW,
    sHeight = imgH;

  if (imgRatio > slotRatio) {
    sWidth = imgH * slotRatio;
    sx = (imgW - sWidth) / 2;
  } else {
    sHeight = imgW / slotRatio;
    sy = (imgH - sHeight) / 2;
  }

  ctx.save();
  ctx.filter = "none"; // ✅ 흑백 제거
  ctx.drawImage(img, sx, sy, sWidth, sHeight, x, y, width, height);
  ctx.restore();
}

const DiakonoelPhotobooth: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stripCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [hasCamera, setHasCamera] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [flashVisible, setFlashVisible] = useState(false);

  const [resultUrl, setResultUrl] = useState<string | null>(null);

  type PrintStage = "idle" | "printing" | "done";
  const [printStage, setPrintStage] = useState<PrintStage>("idle");

  // ✅ QR + 업로드 상태
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const printTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (printTimerRef.current) window.clearTimeout(printTimerRef.current);
    };
  }, []);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setHasCamera(true);
    } catch (err) {
      console.error(err);
      alert("카메라를 사용할 수 없어요 🥲 권한 설정을 확인해 주세요.");
    }
  };

  const runCountdown = (seconds = 3) =>
    new Promise<void>((resolve) => {
      let current = seconds;
      setCountdown(current);
      const interval = window.setInterval(() => {
        current -= 1;
        if (current <= 0) {
          window.clearInterval(interval);
          setCountdown(null);
          resolve();
        } else {
          setCountdown(current);
        }
      }, 1000);
    });

  /**
   * ✅ 저장본도 “미리보기(거울)” 그대로 나오게 캡처도 거울 처리
   * ✅ 흑백 효과 제거 (항상 컬러)
   */
  const captureFrameToCanvas = (canvas: HTMLCanvasElement) => {
    const video = videoRef.current;
    if (!video) return;

    const vW = video.videoWidth;
    const vH = video.videoHeight;
    if (!vW || !vH) return;

    canvas.width = vW;
    canvas.height = vH;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.filter = "none"; // ✅ 흑백 제거

    // 거울 캡처
    ctx.translate(vW, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, vW, vH);

    ctx.restore();
  };

  const flashAndCapture = async (tmpCanvas: HTMLCanvasElement) => {
    captureFrameToCanvas(tmpCanvas);

    setFlashVisible(true);
    await new Promise((res) => setTimeout(res, 180));
    setFlashVisible(false);

    return tmpCanvas.toDataURL("image/jpeg", 0.95);
  };

  const makeStrip = (shots: string[]): Promise<string> => {
    return new Promise((resolve) => {
      const canvas = stripCanvasRef.current;
      if (!canvas) return resolve("");

      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve("");

      const bg = new Image();
      bg.src = TEMPLATE_SRC;

      bg.onload = () => {
        canvas.width = bg.naturalWidth; // 1000
        canvas.height = bg.naturalHeight; // 3000

        ctx.drawImage(bg, 0, 0);

        let loaded = 0;

        shots.forEach((dataUrl, idx) => {
          const img = new Image();
          img.src = dataUrl;

          img.onload = () => {
            drawCover(ctx, img, PHOTO_SLOTS[idx]);
            loaded += 1;

            if (loaded === shots.length) {
              resolve(canvas.toDataURL("image/png"));
            }
          };

          img.onerror = () => {
            console.error("Failed to load shot image:", idx);
            resolve("");
          };
        });
      };

      bg.onerror = () => {
        alert("프레임 PNG를 불러오지 못했어요 😭 public 경로를 확인해줘!");
        resolve("");
      };
    });
  };

  const autoDownload = (dataUrl: string, filename: string) => {
    if (!dataUrl) return;
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const startPrintAnimation = (finalUrl: string, filename: string) => {
    setPrintStage("printing");

    if (printTimerRef.current) window.clearTimeout(printTimerRef.current);

    printTimerRef.current = window.setTimeout(() => {
      setPrintStage("done");
      autoDownload(finalUrl, filename);
    }, 2600);
  };

  const handleStartCapture = async () => {
    if (!hasCamera || isCapturing) return;

    setIsCapturing(true);
    setResultUrl(null);
    setPrintStage("idle");

    setQrUrl(null);
    setUploadError(null);

    const tmpCanvas = document.createElement("canvas");
    const shots: string[] = [];

    for (let i = 0; i < CAPTURE_COUNT; i++) {
      await runCountdown(3);
      const shot = await flashAndCapture(tmpCanvas);
      shots.push(shot);

      if (i < CAPTURE_COUNT - 1) {
        await new Promise((res) => setTimeout(res, 900));
      }
    }

    const stripUrl = await makeStrip(shots);
    if (!stripUrl) {
      alert("스트립 생성 실패! 콘솔을 확인해줘.");
      setIsCapturing(false);
      return;
    }

    const filename = makeFilename(new Date());

    setResultUrl(stripUrl);

    // 1) 프린트 애니메이션
    startPrintAnimation(stripUrl, filename);

    // 2) Firebase 업로드 → QR
    setUploading(true);
    uploadStripToFirebase(stripUrl, filename)
      .then((url) => setQrUrl(url))
      .catch((e) => {
        console.error(e);
        setUploadError("업로드 실패. 인터넷 연결/Storage 설정을 확인해줘!");
      })
      .finally(() => setUploading(false));

    setIsCapturing(false);
  };

  return (
    <div className="dpb-root">
      <h1 className="dpb-title">🕵🏻‍♀️ Diakonos Crime Scene Photobooth 🔎</h1>
      <p className="dpb-subtitle">네컷으로 소중한 순간을 기록하세요</p>

      <div className="dpb-camera-card">
        <div className="dpb-video-wrapper">
          <video
            ref={videoRef}
            className="dpb-video"
            autoPlay
            muted
            playsInline
          />
          {countdown !== null && (
            <div className="dpb-countdown">{countdown}</div>
          )}
          {flashVisible && <div className="dpb-flash" />}
        </div>

        <div className="dpb-controls">
          <div className="dpb-buttons">
            {!hasCamera && (
              <button className="dpb-btn" type="button" onClick={startCamera}>
                카메라 켜기
              </button>
            )}
            <button
              className="dpb-btn"
              type="button"
              onClick={handleStartCapture}
              disabled={!hasCamera || isCapturing || printStage === "printing"}
            >
              {printStage === "printing"
                ? "출력 중..."
                : isCapturing
                ? "촬영 중..."
                : "촬영 시작 ♥︎"}
            </button>
          </div>
        </div>
      </div>

      {/* 프린터 출력 애니메이션 */}
      <div className="dpb-print-area" aria-live="polite">
        <div className="dpb-printer">
          <div className="dpb-printer-top">
            <div className="dpb-printer-led" />
            <div className="dpb-printer-slot" />
          </div>

          <div className="dpb-printer-body">
            <div className="dpb-paper-stage">
              {resultUrl && (
                <img
                  src={resultUrl}
                  alt="Diakonöel strip print"
                  className={[
                    "dpb-paper",
                    printStage === "printing" ? "dpb-paper--printing" : "",
                    printStage === "done" ? "dpb-paper--done" : "",
                  ].join(" ")}
                />
              )}
            </div>

            <div className="dpb-printer-bottom" />
          </div>
        </div>

        <p className="dpb-print-caption">
          {printStage === "printing"
            ? "프린터에서 출력 중…"
            : printStage === "done"
            ? "출력 완료! "
            : "촬영 후 인생네컷이 프린터에서 출력됩니다 🔎"}
        </p>
      </div>

      {/* ✅ QR 영역 */}
      {(uploading || qrUrl || uploadError) && (
        <div className="dpb-qr-card">
          <h3 className="dpb-qr-title">사진 받기 (QR)</h3>

          {uploading && <p className="dpb-qr-desc">업로드 중…</p>}

          {uploadError && (
            <p className="dpb-qr-desc dpb-qr-desc--error">{uploadError}</p>
          )}

          {qrUrl && (
            <>
              <QRCodeCanvas value={qrUrl} size={220} />
              <p className="dpb-qr-desc">
                휴대폰 카메라로 QR을 스캔해서 다운로드해주세요!
              </p>
              <p className="dpb-qr-desc">
                * 인생네컷 촬영 후 웹사이트는 끄지 말아주세요 *
              </p>
            </>
          )}
        </div>
      )}

      <canvas
        ref={stripCanvasRef}
        width={1000}
        height={3000}
        style={{ display: "none" }}
      />
    </div>
  );
};

export default DiakonoelPhotobooth;
