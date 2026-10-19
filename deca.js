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
    const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: `DeCA ${number}`, Author: carrier.name, Creator: "Bouadigital" } });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const L = 40, W = doc.page.width - 80, ink = "#111111", muted = "#555555", line = "#222222";

    // En-tête
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(16).text("DOCUMENTO DE CONTROL ADMINISTRATIVO", L, 40, { width: W - 150 });
    doc.font("Helvetica").fontSize(9).fillColor(muted)
      .text("DeCA · Transporte público de mercancías por carretera · Orden FOM/2861/2012", L, doc.y + 2, { width: W - 150 });
    doc.font("Helvetica-Bold").fontSize(11).fillColor(ink).text(`N.º ${number}`, L, doc.y + 8);
    doc.font("Helvetica").fontSize(9).fillColor(muted).text(`Emitido: ${issuedAt}`, L, doc.y + 2);

    // QR en haut à droite
    const qrSize = 130;
    doc.image(qrPng, L + W - qrSize, 34, { width: qrSize, height: qrSize });
    doc.fontSize(7).fillColor(muted).text("Escanee para descargar este documento", L + W - qrSize - 10, 34 + qrSize + 2, { width: qrSize + 20, align: "center" });

    // Grille de cases numérotées
    let y = 200;
    const row = (cells, h = 54) => {
      let x = L;
      cells.forEach(([n, label, value, w]) => {
        const cw = W * w;
        doc.lineWidth(0.8).strokeColor(line).rect(x, y, cw, h).stroke();
        doc.font("Helvetica").fontSize(7).fillColor(muted).text(`${n}. ${label.toUpperCase()}`, x + 6, y + 5, { width: cw - 12 });
        doc.font("Helvetica-Bold").fontSize(11).fillColor(ink).text(value || "—", x + 6, y + 18, { width: cw - 12, height: h - 22, ellipsis: true });
        x += cw;
      });
      y += h;
    };
    row([["1", "Cargador contractual", d.cargador, 0.65], ["2", "NIF cargador", d.cargadorNif, 0.35]]);
    row([["3", "Transportista efectivo", [carrier.name, [carrier.address, carrier.city].filter(Boolean).join(", ")].filter(Boolean).join("\n"), 0.65], ["4", "NIF transportista", carrier.nif, 0.35]], 64);
    row([["5", "Lugar de origen (carga)", d.origen, 0.5], ["6", "Lugar de destino (entrega)", d.destino, 0.5]]);
    row([["7", "Naturaleza de la mercancía", d.mercancia, 0.65], ["8", "Peso", d.peso ? d.peso + " t" : "", 0.35]]);
    row([["9", "Matrícula vehículo", d.matricula, 0.35], ["10", "Matrícula remolque / semirremolque", d.remolque, 0.35], ["11", "Fecha", fmtDate(d.fecha), 0.3]]);
    row([["12", "Observaciones", d.observaciones, 1]], 70);

    // Lien en clair (si le QR est abîmé)
    y += 14;
    doc.font("Helvetica").fontSize(7).fillColor(muted).text("Enlace de descarga:", L, y);
    doc.fontSize(6.5).fillColor("#1e3a8a").text(url, L, doc.y + 1, { width: W, link: url });

    // Pied de page
    doc.fontSize(7).fillColor(muted).text(
      `Documento generado electrónicamente por ${carrier.name} con Bouadigital. El transportista conserva este documento a disposición de los servicios de inspección durante el transporte.`,
      L, doc.page.height - 70, { width: W, align: "center" }
    );
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
