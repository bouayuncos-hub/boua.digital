/* =====================================================================
   Bouadigital — Fonction serveur DeCA (Vercel / Node.js 18+)
   POST /api/deca
   En-tête : Authorization: Bearer <ID token Firebase de l'utilisateur>
   Corps JSON : { missionId, data: { cargador, cargadorNif, origen, destino,
                  mercancia, peso, matricula, remolque, fecha, observaciones } }
   Réponse : { url, number, path }
     url = lien HTTPS public de téléchargement direct du PDF (aussi encodé dans le QR)

   Variables d'environnement (Vercel > Settings > Environment Variables) :
     FIREBASE_SERVICE_ACCOUNT  JSON complet du compte de service (une seule ligne)
     FIREBASE_STORAGE_BUCKET   ex. bouadigital.firebasestorage.app
   ===================================================================== */
const admin = require("firebase-admin");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const crypto = require("crypto");

const GRACE_DAYS = 7; // identique à app.html et firestore.rules
const LIMITS = { cargador: 120, cargadorNif: 20, origen: 160, destino: 160, mercancia: 160, peso: 20, matricula: 20, remolque: 20, fecha: 10, observaciones: 400 };
const REQUIRED = ["cargador", "cargadorNif", "origen", "destino", "mercancia", "matricula"];

function initAdmin() {
  if (admin.apps.length) return admin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw httpError(500, "config", "FIREBASE_SERVICE_ACCOUNT manquant sur Vercel");
  let sa;
  try { sa = JSON.parse(raw); } catch (e) { throw httpError(500, "config", "FIREBASE_SERVICE_ACCOUNT n'est pas un JSON valide"); }
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${sa.project_id}.firebasestorage.app`
  });
  return admin;
}

function httpError(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }

function clean(data) {
  const out = {};
  for (const k of Object.keys(LIMITS)) {
    out[k] = String((data && data[k]) ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, LIMITS[k]);
  }
  out.matricula = out.matricula.toUpperCase();
  out.remolque = out.remolque.toUpperCase();
  out.cargadorNif = out.cargadorNif.toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.fecha)) out.fecha = new Date().toISOString().slice(0, 10);
  const missing = REQUIRED.filter(k => !out[k]);
  if (missing.length) throw httpError(400, "missing", "Champs obligatoires manquants : " + missing.join(", "));
  return out;
}

function isActive(c) {
  const now = Date.now();
  if (c.trialEnds && c.trialEnds.toMillis() > now) return true;
  return !!(c.paidUntil && c.paidUntil.toMillis() + GRACE_DAYS * 864e5 > now);
}

const fmtDate = iso => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };

/* ---------- Construction du PDF (A4, en espagnol pour le contrôle) ---------- */
function buildDecaPdf({ number, d, carrier, qrPng, url, issuedAt }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: `DeCA ${number}`, Author: carrier.name, Subject: "Documento de Control Administrativo", Creator: "Bouadigital" } });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const PW = doc.page.width, PH = doc.page.height, M = 36, W = PW - 2 * M;
    const navy = "#0a1330", blue = "#1e3a8a", amber = "#f5a524", ink = "#111827", muted = "#5b6478", line = "#c9cfdb", soft = "#f3f5f9";

    // ---- Bandeau d'en-tête
    doc.rect(0, 0, PW, 150).fill(navy);
    doc.rect(0, 150, PW, 4).fill(amber);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(26).text("DeCA", M, 30);
    doc.font("Helvetica-Bold").fontSize(11).text("DOCUMENTO DE CONTROL ADMINISTRATIVO", M, 64, { width: W - 150 });
    doc.font("Helvetica").fontSize(8.5).fillColor("#c7d2fe")
      .text("Transporte público de mercancías por carretera · Orden FOM/2861/2012", M, 80, { width: W - 150 });
    // numéro + date
    doc.roundedRect(M, 102, 250, 32, 4).fill("#16224d");
    doc.fillColor("#94a3c4").font("Helvetica").fontSize(7).text("N.º DE DOCUMENTO", M + 10, 108);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(11).text(number, M + 10, 118);
    doc.fillColor("#94a3c4").font("Helvetica").fontSize(7).text("EMITIDO", M + 170, 108);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9).text(issuedAt, M + 170, 119);
    // QR dans une carte blanche
    const qs = 118, qx = PW - M - qs - 8, qy = 16;
    doc.roundedRect(qx - 4, qy - 4, qs + 16, qs + 16, 6).fill("#ffffff");
    doc.image(qrPng, qx + 4, qy + 4, { width: qs, height: qs });

    // ---- Sections
    let y = 172;
    const section = (title) => {
      doc.rect(M, y, 3, 12).fill(amber);
      doc.fillColor(blue).font("Helvetica-Bold").fontSize(9).text(title.toUpperCase(), M + 9, y + 2, { characterSpacing: 0.6 });
      y += 20;
    };
    const cells = (list, h = 48) => {
      let x = M;
      list.forEach(([n, label, value, w, big]) => {
        const cw = W * w;
        doc.roundedRect(x + 2, y, cw - 4, h, 4).fillAndStroke(soft, line);
        doc.fillColor(muted).font("Helvetica").fontSize(6.8).text(`${n}  ${label.toUpperCase()}`, x + 10, y + 7, { width: cw - 20, characterSpacing: 0.3 });
        doc.fillColor(ink).font("Helvetica-Bold").fontSize(big ? 12 : 10.5)
          .text(value || "—", x + 10, y + 19, { width: cw - 20, height: h - 22, ellipsis: true, lineGap: 1 });
        x += cw;
      });
      y += h + 6;
    };

    section("Intervinientes");
    cells([["1", "Cargador contractual", d.cargador, 0.66], ["2", "NIF / CIF cargador", d.cargadorNif, 0.34]]);
    cells([["3", "Transportista efectivo", [carrier.name, [carrier.address, carrier.city].filter(Boolean).join(", ")].filter(Boolean).join("\n"), 0.66], ["4", "NIF / CIF transportista", carrier.nif, 0.34]], 58);

    y += 6; section("Trayecto y mercancía");
    cells([["5", "Lugar de origen (carga)", d.origen, 0.5], ["6", "Lugar de destino (entrega)", d.destino, 0.5]], 58);
    cells([["7", "Naturaleza de la mercancía", d.mercancia, 0.66], ["8", "Peso", d.peso ? d.peso + " t" : "", 0.34, true]]);

    y += 6; section("Vehículo");
    cells([["9", "Matrícula vehículo", d.matricula, 0.36, true], ["10", "Matrícula remolque / semirremolque", d.remolque, 0.36, true], ["11", "Fecha del transporte", fmtDate(d.fecha), 0.28, true]]);

    y += 6; section("Observaciones");
    cells([["12", "Observaciones", d.observaciones, 1]], 62);

    // ---- Encadré de vérification
    y += 8;
    doc.roundedRect(M + 2, y, W - 4, 58, 5).fillAndStroke("#eef2ff", "#c7d2fe");
    doc.fillColor(blue).font("Helvetica-Bold").fontSize(9).text("Verificación por los servicios de inspección", M + 14, y + 10);
    doc.fillColor(muted).font("Helvetica").fontSize(7.5)
      .text("Escanee el código QR para descargar el original de este documento. Si el código no se puede leer, utilice el enlace:", M + 14, y + 23, { width: W - 28 });
    doc.fillColor(blue).fontSize(6.3).text(url, M + 14, y + 35, { width: W - 28, link: url, underline: false });

    // ---- Pied de page
    doc.moveTo(M, PH - 48).lineTo(PW - M, PH - 48).lineWidth(0.5).strokeColor(line).stroke();
    doc.fillColor(muted).font("Helvetica").fontSize(6.8).text(
      `Documento generado electrónicamente por ${carrier.name} con Bouadigital. El transportista conserva este documento a disposición de los servicios de inspección durante todo el transporte.`,
      M, PH - 40, { width: W - 90 });
    doc.fillColor(blue).font("Helvetica-Bold").fontSize(8).text("bouadigital", PW - M - 80, PH - 38, { width: 80, align: "right" });
    doc.end();
  });
}

/* ---------- Gestionnaire HTTP ---------- */
async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method", message: "Utiliser POST" });

  try {
    const fb = initAdmin();
    const db = fb.firestore();

    // 1. Qui appelle ?
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!m) throw httpError(401, "auth", "Connexion requise");
    let decoded;
    try { decoded = await fb.auth().verifyIdToken(m[1]); } catch (e) { throw httpError(401, "auth", "Session expirée, reconnectez-vous"); }
    const uid = decoded.uid;

    // 2. Données reçues
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const missionId = String(body.missionId || "");
    if (!/^[A-Za-z0-9]{10,40}$/.test(missionId)) throw httpError(400, "mission", "Mission invalide");
    const d = clean(body.data);

    // 3. Droits : membre de l'entreprise, abonnement actif, mission existante
    const user = await db.doc(`users/${uid}`).get();
    if (!user.exists) throw httpError(403, "forbidden", "Compte non rattaché à une entreprise");
    const cid = user.data().companyId;
    const [companySnap, missionSnap] = await Promise.all([db.doc(`companies/${cid}`).get(), db.doc(`companies/${cid}/missions/${missionId}`).get()]);
    if (!companySnap.exists || !missionSnap.exists) throw httpError(404, "notfound", "Mission introuvable");
    const company = companySnap.data(), mission = missionSnap.data();
    if (!isActive(company)) throw httpError(402, "inactive", "Abonnement inactif");
    if (!company.nif) throw httpError(400, "nif", "Renseignez le NIF de votre entreprise dans Réglages");

    // 4. URL publique HTTPS connue à l'avance (jeton de téléchargement Firebase)
    const bucket = fb.storage().bucket();
    const stamp = Date.now();
    const path = `deca/${cid}/${missionId}-${stamp}.pdf`;
    const downloadToken = crypto.randomUUID();
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${downloadToken}`;
    const number = `DECA-${(mission.ref || missionId).replace(/^M-/, "")}`;

    // 5. QR code de cette URL
    const qrPng = await QRCode.toBuffer(url, { errorCorrectionLevel: "M", margin: 1, width: 400 });

    // 6. PDF avec le QR intégré
    const issuedAt = new Date(stamp).toLocaleString("es-ES", { timeZone: "Europe/Madrid", dateStyle: "short", timeStyle: "short" });
    const carrier = { name: company.name || "", nif: company.nif || "", address: company.address || "", city: company.city || "" };
    const pdf = await buildDecaPdf({ number, d, carrier, qrPng, url, issuedAt });

    // 7. Enregistrement : fichier + trace sur la mission
    await bucket.file(path).save(pdf, {
      resumable: false,
      contentType: "application/pdf",
      metadata: { cacheControl: "public, max-age=31536000", contentDisposition: `inline; filename="${number}.pdf"`, metadata: { firebaseStorageDownloadTokens: downloadToken } }
    });
    await missionSnap.ref.update({
      deca: { number, url, path, data: d, createdBy: uid, createdAt: admin.firestore.FieldValue.serverTimestamp() }
    });

    return res.status(200).json({ url, number, path });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error("DeCA", e);
    return res.status(status).json({ error: e.code || "server", message: e.message || "Erreur serveur" });
  }
}

module.exports = handler;
module.exports.buildDecaPdf = buildDecaPdf;
module.exports.clean = clean;
