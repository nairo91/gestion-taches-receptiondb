require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

const app = express();

// ----- CONFIG BDD (reception-db) ----- //
const receptionPool = new Pool({
  connectionString: process.env.RECEPTION_DB_URL,
  ssl:
    process.env.DB_SSL === 'true'
      ? { rejectUnauthorized: false }
      : false,
});

// ----- CONFIG UPLOAD ----- //
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// ----- CONFIG VUES & STATIC ----- //
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ----- AUTHENTIFICATION VIA CSV ----- //

const USERS_CSV_PATH =
  process.env.USERS_CSV_PATH || path.join(__dirname, 'users.csv');

function loadUsersFromCsv() {
  if (!fs.existsSync(USERS_CSV_PATH)) {
    console.warn('Fichier users.csv introuvable :', USERS_CSV_PATH);
    return [];
  }
  const content = fs.readFileSync(USERS_CSV_PATH, 'utf8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];

  const sep = content.includes(';') ? ';' : ',';

  const header = lines[0].split(sep).map((h) => h.trim().toLowerCase());
  const idxNom = header.indexOf('nom');
  const idxPrenom = header.indexOf('prenom');
  const idxEmail = header.indexOf('email');
  const idxPassword = header.indexOf('password');

  const users = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep);
    users.push({
      nom: idxNom >= 0 && cols[idxNom] ? cols[idxNom].trim() : '',
      prenom: idxPrenom >= 0 && cols[idxPrenom] ? cols[idxPrenom].trim() : '',
      email:
        idxEmail >= 0 && cols[idxEmail]
          ? cols[idxEmail].trim().toLowerCase()
          : '',
      password:
        idxPassword >= 0 && cols[idxPassword] ? cols[idxPassword].trim() : '',
    });
  }
  return users;
}

// on charge en mémoire au démarrage
let USERS = loadUsersFromCsv();

function authenticate(email, password) {
  const normalizedEmail = (email || '').trim().toLowerCase();
  const pwd = (password || '').trim();

  return USERS.find(
    (u) => u.email === normalizedEmail && u.password === pwd
  );
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

// mettre l'utilisateur courant + la liste des utilisateurs dispo dans les vues
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.usersList = USERS; // pour les choix multiples "Qui ?"
  next();
});

// ----- ROUTES AUTH ----- //

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = authenticate(email, password);

  if (!user) {
    return res.status(401).render('login', {
      error: 'Email ou mot de passe invalide',
    });
  }

  req.session.user = {
    email: user.email,
    nom: user.nom,
    prenom: user.prenom,
  };

  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// protéger toutes les routes suivantes
app.use(requireAuth);

// ----- ROUTES METIER ----- //

// Page d'accueil : liste des chantiers
app.get('/', async (req, res) => {
  const result = await receptionPool.query(
    `
    SELECT id,
           CASE
             WHEN nom IS NOT NULL AND nom <> '' THEN nom
             ELSE name
           END AS display_name,
           created_at
    FROM chantiers
    ORDER BY created_at DESC, id DESC
    `
  );

  res.render('index', { chantiers: result.rows });
});

// Page de suivi des interventions pour un chantier
app.get('/chantiers/:id/taches', async (req, res) => {
  const chantierId = req.params.id;
  const filters = {
    floor: req.query.floor || '',
    room: req.query.room || '',
    lot: req.query.lot || '',
    status: req.query.status || '',
  };

  // récupérer le chantier
  const chantierResult = await receptionPool.query(
    `
    SELECT id,
           CASE
             WHEN nom IS NOT NULL AND nom <> '' THEN nom
             ELSE name
           END AS display_name
    FROM chantiers
    WHERE id = $1
    `,
    [chantierId]
  );
  if (!chantierResult.rows.length) {
    return res.status(404).send('Chantier introuvable');
  }
  const chantier = chantierResult.rows[0];

  // récupérer les floors pour ce chantier
  const floorsResult = await receptionPool.query(
    `SELECT id, name FROM floors WHERE chantier_id = $1 ORDER BY name`,
    [chantierId]
  );
  const floors = floorsResult.rows;

  // récupérer les rooms pour ce chantier
  const roomsResult = await receptionPool.query(
    `
    SELECT r.id, r.name, r.floor_id, f.name AS floor_name
    FROM rooms r
    JOIN floors f ON r.floor_id = f.id
    WHERE f.chantier_id = $1
    ORDER BY f.name, r.name
    `,
    [chantierId]
  );
  const rooms = roomsResult.rows;

  // construire la requête pour les interventions
  let query = `
    SELECT i.*,
           f.name AS floor_name,
           r.name AS room_name
    FROM interventions i
    LEFT JOIN floors f ON i.floor_id = f.id
    LEFT JOIN rooms r ON i.room_id = r.id
    WHERE f.chantier_id = $1
  `;
  const params = [chantierId];

  if (filters.floor) {
    params.push(filters.floor);
    query += ` AND f.id = $${params.length}`;
  }
  if (filters.room) {
    params.push(filters.room);
    query += ` AND r.id = $${params.length}`;
  }
  if (filters.lot) {
    params.push(filters.lot);
    query += ` AND i.lot = $${params.length}`;
  }
  if (filters.status) {
    params.push(filters.status);
    query += ` AND i.status = $${params.length}`;
  }

  query += `
    ORDER BY f.name, r.name, i.created_at, i.id
  `;

  const interventionsResult = await receptionPool.query(query, params);

  res.render('taches', {
    chantier,
    interventions: interventionsResult.rows,
    floors,
    rooms,
    filters,
  });
});

// Changer le statut d'une intervention (A FAIRE / EN COURS / TERMINÉ)
app.post('/interventions/:id/status', async (req, res) => {
  const id = req.params.id;
  const { new_status, date, persons } = req.body;
  const actor = req.session.user;

  const allowed = ['a faire', 'en cours', 'terminé'];
  if (!allowed.includes(new_status)) {
    return res.status(400).send('Statut invalide');
  }

  let personsArray = [];
  if (Array.isArray(persons)) {
    personsArray = persons.filter((p) => p && p.trim().length > 0);
  } else if (typeof persons === 'string' && persons.trim().length > 0) {
    personsArray = [persons.trim()];
  }

  // si personne choisie, on utilise la sélection,
  // sinon on met l'utilisateur connecté
  if (!personsArray.length) {
    const name = `${actor.prenom || ''} ${actor.nom || ''}`.trim();
    personsArray = [name || actor.email];
  }

  const personsText = personsArray.join(', ');

  const dateText =
    (date && date.trim().length > 0 ? date.trim() : new Date().toISOString().slice(0, 10));

  let actionText = '';
  if (new_status === 'a faire') {
    actionText = `Réinitialisé le ${dateText} par ${actor.prenom || ''} ${actor.nom || ''}`.trim();
  } else if (new_status === 'en cours') {
    actionText = `En cours depuis le ${dateText} (par ${actor.prenom || ''} ${actor.nom || ''})`.trim();
  } else if (new_status === 'terminé') {
    actionText = `Terminé le ${dateText} (validé par ${actor.prenom || ''} ${actor.nom || ''})`.trim();
  }

  await receptionPool.query(
    `
    UPDATE interventions
    SET status = $1,
        person = $2,
        action = $3
    WHERE id = $4
    `,
    [new_status, personsText, actionText, id]
  );

  res.redirect('back');
});

// Création manuelle d'une intervention (avec choix multiple de pièces)
app.post('/chantiers/:chantierId/interventions', async (req, res) => {
  const chantierId = req.params.chantierId;
  const { floor_id, room_ids, lot, task } = req.body;
  const user = req.session.user;

  if (!floor_id || !lot || !task) {
    return res.status(400).send('Étage, lot et tâche sont obligatoires.');
  }

  let roomIdsArray = [];
  if (Array.isArray(room_ids)) {
    roomIdsArray = room_ids;
  } else if (typeof room_ids === 'string') {
    roomIdsArray = [room_ids];
  }
  roomIdsArray = roomIdsArray.filter((id) => id && String(id).trim().length > 0);

  if (!roomIdsArray.length) {
    return res.status(400).send('Veuillez sélectionner au moins une pièce.');
  }

  const client = await receptionPool.connect();
  try {
    await client.query('BEGIN');

    // vérifier que l'étage appartient bien au chantier
    const floorRes = await client.query(
      'SELECT id, name FROM floors WHERE id = $1 AND chantier_id = $2',
      [floor_id, chantierId]
    );
    if (!floorRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).send("Étage invalide pour ce chantier");
    }
    const floor = floorRes.rows[0];

    for (const roomId of roomIdsArray) {
      const roomRes = await client.query(
        'SELECT id, name FROM rooms WHERE id = $1 AND floor_id = $2',
        [roomId, floor.id]
      );
      if (!roomRes.rows.length) {
        continue; // on ignore les pièces invalides
      }
      const room = roomRes.rows[0];

      await client.query(
        `
        INSERT INTO interventions (
          user_id, old_floor_name, old_room_name,
          lot, task, created_at, status, person, action,
          floor_id, room_id
        )
        VALUES ($1, $2, $3, $4, $5, now(), 'a faire', '', 'Création', $6, $7)
        `,
        [
          user.email,
          floor.name,
          room.name,
          lot,
          task,
          floor.id,
          room.id,
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    console.error(err);
    await client.query('ROLLBACK');
    return res.status(500).send("Erreur lors de la création des interventions.");
  } finally {
    client.release();
  }

  res.redirect(`/chantiers/${chantierId}/taches`);
});

// Formulaire d'import Excel
app.get('/import', async (req, res) => {
  const result = await receptionPool.query(
    `
    SELECT id,
           CASE
             WHEN nom IS NOT NULL AND nom <> '' THEN nom
             ELSE name
           END AS display_name
    FROM chantiers
    ORDER BY created_at DESC, id DESC
    `
  );

  res.render('import', {
    chantiers: result.rows,
    message: null,
    error: null,
  });
});

// Traitement de l'import Excel
app.post('/import', upload.single('fichier'), async (req, res) => {
  const chantierId = req.body.chantier_id;
  const filePath = req.file ? req.file.path : null;
  const user = req.session.user;

  const chantiers = (
    await receptionPool.query(
      `
      SELECT id,
             CASE
               WHEN nom IS NOT NULL AND nom <> '' THEN nom
               ELSE name
             END AS display_name
      FROM chantiers
      ORDER BY created_at DESC, id DESC
      `
    )
  ).rows;

  if (!chantierId || !filePath) {
    return res.status(400).render('import', {
      chantiers,
      message: null,
      error: 'Merci de sélectionner un chantier et un fichier.',
    });
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (e) {
    console.error(e);
    return res.status(500).render('import', {
      chantiers,
      message: null,
      error: 'Impossible de lire le fichier Excel.',
    });
  }

  const sheet = workbook.worksheets[0];

  // On attend un format :
  // A: floor_name | B: room_name | C: lot | D: task
  const rowsData = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // en-tête

    const floorName =
      row.getCell(1).value !== null
        ? String(row.getCell(1).value).trim()
        : '';
    const roomName =
      row.getCell(2).value !== null
        ? String(row.getCell(2).value).trim()
        : '';
    const lot =
      row.getCell(3).value !== null
        ? String(row.getCell(3).value).trim()
        : '';
    const task =
      row.getCell(4).value !== null
        ? String(row.getCell(4).value).trim()
        : '';

    if (!task) return;

    rowsData.push({ floorName, roomName, lot, task });
  });

  let importedCount = 0;
  let skipped = [];

  const client = await receptionPool.connect();
  try {
    await client.query('BEGIN');

    for (const row of rowsData) {
      const { floorName, roomName, lot, task } = row;

      // trouver l'étage
      const floorRes = await client.query(
        'SELECT id, name FROM floors WHERE chantier_id = $1 AND name = $2',
        [chantierId, floorName]
      );
      if (!floorRes.rows.length) {
        skipped.push(
          `Ligne avec étage "${floorName}", pièce "${roomName}" ignorée (étage introuvable).`
        );
        continue;
      }
      const floor = floorRes.rows[0];

      // trouver la pièce
      const roomRes = await client.query(
        'SELECT id, name FROM rooms WHERE floor_id = $1 AND name = $2',
        [floor.id, roomName]
      );
      if (!roomRes.rows.length) {
        skipped.push(
          `Ligne avec étage "${floorName}", pièce "${roomName}" ignorée (pièce introuvable).`
        );
        continue;
      }
      const room = roomRes.rows[0];

      await client.query(
        `
        INSERT INTO interventions (
          user_id, old_floor_name, old_room_name,
          lot, task, created_at, status, person, action,
          floor_id, room_id
        )
        VALUES ($1, $2, $3, $4, $5, now(), 'a faire', '', 'Création', $6, $7)
        `,
        [
          user.email,
          floor.name,
          room.name,
          lot,
          task,
          floor.id,
          room.id,
        ]
      );
      importedCount++;
    }

    await client.query('COMMIT');
  } catch (err) {
    console.error(err);
    await client.query('ROLLBACK');
    return res.status(500).render('import', {
      chantiers,
      message: null,
      error: "Erreur pendant l'import, voir les logs.",
    });
  } finally {
    client.release();
    fs.unlink(filePath, () => {});
  }

  let message = `Import terminé : ${importedCount} tâches créées (statut: a faire).`;
  if (skipped.length) {
    message +=
      ' Certaines lignes ont été ignorées : ' + skipped.slice(0, 10).join(' ');
  }

  res.render('import', {
    chantiers,
    message,
    error: null,
  });
});

// ----- DEMARRAGE ----- //
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
