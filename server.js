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

// ----- SESSION ----- //
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'secret',
    resave: false,
    saveUninitialized: false,
  })
);


// ---- CATALOGUE LOTS : VUE LISTE ----
app.get('/catalogue', async (req, res) => {
  const result = await receptionPool.query(
    `
    SELECT lot, COUNT(*) AS nb_tasks
    FROM lot_tasks
    GROUP BY lot
    ORDER BY lot
    `
  );

  res.render('catalogue', {
    lots: result.rows,
  });
});

// ---- CATALOGUE LOTS : IMPORT EXCEL ----
// GET : formulaire
app.get('/catalogue/import', (req, res) => {
  res.render('catalogue_import', {
    message: null,
    error: null,
  });
});

// POST : traitement du fichier
app.post('/catalogue/import', upload.single('fichier'), async (req, res) => {
  const filePath = req.file ? req.file.path : null;

  if (!filePath) {
    return res.status(400).render('catalogue_import', {
      message: null,
      error: 'Merci de sélectionner un fichier Excel.',
    });
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (e) {
    console.error(e);
    return res.status(500).render('catalogue_import', {
      message: null,
      error: 'Impossible de lire le fichier Excel.',
    });
  }

  const sheet = workbook.worksheets[0];
  let currentLot = null;
  let inserted = 0;

  const client = await receptionPool.connect();
  try {
    await client.query('BEGIN');
    // on vide le catalogue actuel pour repartir propre
    await client.query('DELETE FROM lot_tasks');

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      // on ignore la première ligne si c'est un titre
      if (rowNumber === 1) return;

      let lotCell = row.getCell(1).value;
      let taskCell = row.getCell(2).value;

      let lot = lotCell ? String(lotCell).trim() : '';
      let task = taskCell ? String(taskCell).trim() : '';

      if (lot) {
        currentLot = lot;
      }

      if (!currentLot || !task) return;

      client.query(
        'INSERT INTO lot_tasks (lot, task) VALUES ($1, $2)',
        [currentLot, task]
      );
      inserted++;
    });

    await client.query('COMMIT');
  } catch (err) {
    console.error(err);
    await client.query('ROLLBACK');
    return res.status(500).render('catalogue_import', {
      message: null,
      error: "Erreur pendant l'import du catalogue.",
    });
  } finally {
    client.release();
    fs.unlink(filePath, () => {});
  }

  res.render('catalogue_import', {
    message: `Import terminé : ${inserted} tâches enregistrées dans le catalogue.`,
    error: null,
  });
});

// ---- APPLIQUER DES LOTS À UN CHANTIER ----
// Formulaire
app.get('/chantiers/:id/lots', async (req, res) => {
  const chantierId = req.params.id;

  // chantier
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

  // floors / rooms
  const floorsResult = await receptionPool.query(
    'SELECT id, name FROM floors WHERE chantier_id = $1 ORDER BY name',
    [chantierId]
  );
  const floors = floorsResult.rows;

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

  // lots disponibles pour CE chantier
  const lotsResult = await receptionPool.query(
    `
    SELECT lot, COUNT(*) AS nb_tasks
    FROM chantier_lot_tasks
    WHERE chantier_id = $1
    GROUP BY lot
    ORDER BY lot
    `,
    [chantierId]
  );

  const lots = lotsResult.rows;

  res.render('chantier_lots', {
    chantier,
    floors,
    rooms,
    lots,
    message: null,
    error: null,
  });
});

// Traitement : appliquer les lots sélectionnés
app.post('/chantiers/:id/lots/apply', async (req, res) => {
  const chantierId = req.params.id;
  const { floor_id, room_ids, all_rooms_on_floor, lots } = req.body;
  const user = req.session.user;

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

  // recharge floors, rooms, lots pour ré-affichage en cas d'erreur
  const floors = (await receptionPool.query(
    'SELECT id, name FROM floors WHERE chantier_id = $1 ORDER BY name',
    [chantierId]
  )).rows;

  const rooms = (await receptionPool.query(
    `
    SELECT r.id, r.name, r.floor_id, f.name AS floor_name
    FROM rooms r
    JOIN floors f ON r.floor_id = f.id
    WHERE f.chantier_id = $1
    ORDER BY f.name, r.name
    `,
    [chantierId]
  )).rows;

  const lotsList = (
    await receptionPool.query(
      `
      SELECT lot, COUNT(*) AS nb_tasks
      FROM chantier_lot_tasks
      WHERE chantier_id = $1
      GROUP BY lot
      ORDER BY lot
      `,
      [chantierId]
    )
  ).rows;


  if (!floor_id) {
    return res.status(400).render('chantier_lots', {
      chantier,
      floors,
      rooms,
      lots: lotsList,
      message: null,
      error: "Veuillez sélectionner un étage.",
    });
  }

  // traiter liste de lots
  let lotsArray = [];
  if (Array.isArray(lots)) lotsArray = lots;
  else if (typeof lots === 'string') lotsArray = [lots];
  lotsArray = lotsArray.filter(l => l && l.trim().length > 0);

  if (!lotsArray.length) {
    return res.status(400).render('chantier_lots', {
      chantier,
      floors,
      rooms,
      lots: lotsList,
      message: null,
      error: "Veuillez sélectionner au moins un lot.",
    });
  }

  // déterminer les pièces ciblées
  let roomIdsArray = [];
  if (all_rooms_on_floor === 'on') {
    // toutes les pièces de l'étage
    const r = await receptionPool.query(
      'SELECT id, name FROM rooms WHERE floor_id = $1 ORDER BY name',
      [floor_id]
    );
    roomIdsArray = r.rows.map(rr => rr.id);
  } else {
    if (Array.isArray(room_ids)) roomIdsArray = room_ids;
    else if (typeof room_ids === 'string') roomIdsArray = [room_ids];
    roomIdsArray = roomIdsArray.filter(id => id && String(id).trim().length > 0);
  }

  if (!roomIdsArray.length) {
    return res.status(400).render('chantier_lots', {
      chantier,
      floors,
      rooms,
      lots: lotsList,
      message: null,
      error: "Veuillez sélectionner au moins une pièce (ou cocher toutes les pièces de l'étage).",
    });
  }

  const client = await receptionPool.connect();
  let created = 0;
  try {
    await client.query('BEGIN');

    // vérifier que l'étage appartient au chantier
    const floorRes = await client.query(
      'SELECT id, name FROM floors WHERE id = $1 AND chantier_id = $2',
      [floor_id, chantierId]
    );
    if (!floorRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).render('chantier_lots', {
        chantier,
        floors,
        rooms,
        lots: lotsList,
        message: null,
        error: "Étage invalide pour ce chantier.",
      });
    }
    const floor = floorRes.rows[0];

    // préparer map lot -> tâches à partir du catalogue du chantier
    const lotTasksMap = {};
    for (const lot of lotsArray) {
      const tasksRes = await client.query(
        `
        SELECT task
        FROM chantier_lot_tasks
        WHERE chantier_id = $1
          AND lot = $2
        `,
        [chantierId, lot]
      );
      lotTasksMap[lot] = tasksRes.rows.map((r) => r.task);
    }


    // pour chaque pièce
    for (const roomId of roomIdsArray) {
      const roomRes = await client.query(
        'SELECT id, name FROM rooms WHERE id = $1 AND floor_id = $2',
        [roomId, floor.id]
      );
      if (!roomRes.rows.length) continue;
      const room = roomRes.rows[0];

      for (const lot of lotsArray) {
        const tasks = lotTasksMap[lot] || [];
        for (const task of tasks) {
          await client.query(
            `
            INSERT INTO interventions (
              user_id, old_floor_name, old_room_name,
              lot, task, created_at, status, person, action,
              floor_id, room_id
            )
            VALUES ($1, $2, $3, $4, $5, now(), 'a faire', '', 'Création (catalogue)', $6, $7)
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
          created++;
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    console.error(err);
    await client.query('ROLLBACK');
    return res.status(500).render('chantier_lots', {
      chantier,
      floors,
      rooms,
      lots: lotsList,
      message: null,
      error: "Erreur lors de l'application des lots.",
    });
  } finally {
    client.release();
  }

  res.render('chantier_lots', {
    chantier,
    floors,
    rooms,
    lots: lotsList,
    message: `Création terminée : ${created} interventions créées à partir du catalogue.`,
    error: null,
  });
});

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
  const idxRole = header.indexOf('role');

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
        role:
    idxRole >= 0 && cols[idxRole]
      ? cols[idxRole].trim().toLowerCase()
      : 'user',        // valeur par défaut
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

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).send('Accès réservé aux administrateurs.');
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
    role: user.role || 'user',
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

// >>> AJOUTER CE BLOC <<<
// Création d’un nouveau chantier
// Création d’un nouveau chantier
app.post('/chantiers', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.redirect('/');
  }

  const trimmed = name.trim();

  await receptionPool.query(
    `INSERT INTO chantiers (nom, name, created_at)
     VALUES ($1, $1, now())`,
    [trimmed]
  );

  res.redirect('/');
});


// Page de gestion des étages / chambres d'un chantier
app.get('/chantiers/:id/structure', async (req, res) => {
  const chantierId = req.params.id;

  const chantierRes = await receptionPool.query(`
    SELECT id,
           CASE
             WHEN nom IS NOT NULL AND nom <> '' THEN nom
             ELSE name
           END AS display_name
    FROM chantiers
    WHERE id = $1
  `, [chantierId]);

  if (!chantierRes.rows.length) {
    return res.status(404).send('Chantier introuvable');
  }
  const chantier = chantierRes.rows[0];

  const floors = (await receptionPool.query(
    `SELECT id, name FROM floors WHERE chantier_id = $1 ORDER BY name`,
    [chantierId]
  )).rows;

  const rooms = (await receptionPool.query(
    `SELECT r.id, r.name, r.floor_id, f.name AS floor_name
     FROM rooms r
     JOIN floors f ON r.floor_id = f.id
     WHERE f.chantier_id = $1
     ORDER BY f.name, r.name`,
    [chantierId]
  )).rows;

  res.render('chantier_structure', { chantier, floors, rooms });
});

// Création d’un étage
app.post('/chantiers/:id/floors', requireAdmin,async (req, res) => {
  const chantierId = req.params.id;
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.redirect(`/chantiers/${chantierId}/structure`);
  }

  await receptionPool.query(
    `INSERT INTO floors (name, chantier_id) VALUES ($1, $2)`,
    [name.trim(), chantierId]
  );

  res.redirect(`/chantiers/${chantierId}/structure`);
});

// Création d’une chambre / pièce dans un étage
app.post('/floors/:floorId/rooms', requireAdmin,async (req, res) => {
  const floorId = req.params.floorId;
  const { name, chantier_id } = req.body; // on renvoie l'id du chantier dans le form

  if (!name || !name.trim()) {
    return res.redirect(`/chantiers/${chantier_id}/structure`);
  }

  await receptionPool.query(
    `INSERT INTO rooms (name, floor_id) VALUES ($1, $2)`,
    [name.trim(), floorId]
  );

  res.redirect(`/chantiers/${chantier_id}/structure`);
});

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

  // floors
  const floorsResult = await receptionPool.query(
    `SELECT id, name FROM floors WHERE chantier_id = $1 ORDER BY name`,
    [chantierId]
  );
  const floors = floorsResult.rows;

  // rooms
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

  // interventions filtrées
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

  query += ` ORDER BY f.name, r.name, i.created_at, i.id`;

  const interventionsResult = await receptionPool.query(query, params);

   // lots et tâches déjà utilisés (pour les filtres éventuels, si tu veux les garder)
  const lotsResult = await receptionPool.query(
    `
    SELECT DISTINCT i.lot
    FROM interventions i
    LEFT JOIN floors f ON i.floor_id = f.id
    WHERE f.chantier_id = $1
      AND i.lot IS NOT NULL
      AND i.lot <> ''
    ORDER BY i.lot
    `,
    [chantierId]
  );

  const tasksResult = await receptionPool.query(
    `
    SELECT DISTINCT i.task
    FROM interventions i
    LEFT JOIN floors f ON i.floor_id = f.id
    WHERE f.chantier_id = $1
      AND i.task IS NOT NULL
      AND i.task <> ''
    ORDER BY i.task
    `,
    [chantierId]
  );

  // 🔹 Nouveau : catalogue LOT / Tâche spécifique à ce chantier
  const catalogueLotsResult = await receptionPool.query(
    `
    SELECT DISTINCT lot
    FROM chantier_lot_tasks
    WHERE chantier_id = $1
    ORDER BY lot
    `,
    [chantierId]
  );
  const catalogueLots = catalogueLotsResult.rows;

  const lotTasksResult = await receptionPool.query(
    `
    SELECT lot, task
    FROM chantier_lot_tasks
    WHERE chantier_id = $1
    ORDER BY lot, task
    `,
    [chantierId]
  );
  const lotTasks = lotTasksResult.rows;

  res.render('taches', {
    chantier,
    interventions: interventionsResult.rows,
    floors,
    rooms,
    filters,
    lotsOptions: lotsResult.rows,
    tasksOptions: tasksResult.rows,
    catalogueLots,
    lotTasks,   // ← bien envoyé à la vue
  });

  });





// Changer le statut d'une intervention (A FAIRE / EN COURS / TERMINÉ)
// Changer le statut d'une intervention (A FAIRE / EN COURS / TERMINÉ)
app.post('/interventions/:id/status', async (req, res) => {
  const id = req.params.id;
  const { new_status, date, persons } = req.body;
  const actor = req.session.user;

  const allowed = ['a faire', 'en cours', 'terminé'];
  if (!allowed.includes(new_status)) {
    return res.status(400).send('Statut invalide');
  }

  // construire la liste de personnes sélectionnées
  let personsArray = [];
  if (Array.isArray(persons)) {
    personsArray = persons.filter((p) => p && p.trim().length > 0);
  } else if (typeof persons === 'string' && persons.trim().length > 0) {
    personsArray = [persons.trim()];
  }

  const actorName = `${actor.prenom || ''} ${actor.nom || ''}`.trim() || actor.email;

  // si aucune personne sélectionnée, on met l'utilisateur courant
  if (!personsArray.length) {
    personsArray = [actorName];
  }
  const personsText = personsArray.join(', ');

  const dateText =
    (date && date.trim().length > 0 ? date.trim() : new Date().toISOString().slice(0, 10));

  const client = await receptionPool.connect();
  try {
    await client.query('BEGIN');

    // récupérer l'état actuel de l'intervention
    const currentRes = await client.query(
      'SELECT status, person, action FROM interventions WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!currentRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).send("Intervention introuvable");
    }
    const current = currentRes.rows[0];

    // on construit la nouvelle phrase d'action
    let eventText = '';
    let newPerson = current.person; // par défaut on garde l'ancien "Qui ?"

    if (new_status === 'a faire') {
      eventText = `Réinitialisé le ${dateText} par ${actorName}`;
    } else if (new_status === 'en cours') {
      eventText = `En cours depuis le ${dateText} (par ${personsText})`;
      newPerson = personsText; // ici on met à jour le "Qui ?" (ceux qui font la tâche)
    } else if (new_status === 'terminé' && (!actor || actor.role !== 'admin')) {
  // la validation doit toujours être faite par la personne connectée
  eventText = `Terminé le ${dateText} (validé par ${actorName})`;
  // on laisse newPerson = current.person pour garder "qui a fait la tâche"
}

    const newAction =
      (current.action && current.action.length ? current.action + '\n' : '') + eventText;

    // mise à jour de l'intervention (on empile l'action)
    await client.query(
      `
      UPDATE interventions
      SET status = $1,
          person = $2,
          action = $3
      WHERE id = $4
      `,
      [new_status, newPerson, newAction, id]
    );

    // enregistrement dans la table d'historique
    await client.query(
      `
      INSERT INTO intervention_history (
        intervention_id, event_type,
        old_status, new_status,
        persons, date_event,
        actor_email, actor_name,
        note
      )
      VALUES ($1, 'status_change',
              $2, $3,
              $4, $5,
              $6, $7,
              $8)
      `,
      [
        id,
        current.status,
        new_status,
        personsText,
        dateText,
        actor.email,
        actorName,
        eventText,
      ]
    );

    await client.query('COMMIT');
  } catch (err) {
    console.error(err);
    await client.query('ROLLBACK');
    return res.status(500).send("Erreur lors du changement de statut.");
  } finally {
    client.release();
  }

  res.redirect('back');
});

// Historique complet d'une intervention
app.get('/interventions/:id/history',requireAdmin, async (req, res) => {
  const id = req.params.id;

  // récupérer l'intervention + chantier
  const interventionRes = await receptionPool.query(
    `
    SELECT i.*,
           f.name AS floor_name,
           r.name AS room_name,
           c.id AS chantier_id,
           CASE
             WHEN c.nom IS NOT NULL AND c.nom <> '' THEN c.nom
             ELSE c.name
           END AS chantier_name
    FROM interventions i
    LEFT JOIN floors f ON i.floor_id = f.id
    LEFT JOIN rooms r ON i.room_id = r.id
    LEFT JOIN chantiers c ON f.chantier_id = c.id
    WHERE i.id = $1
    `,
    [id]
  );

  if (!interventionRes.rows.length) {
    return res.status(404).send("Intervention introuvable");
  }
  const intervention = interventionRes.rows[0];

  // récupérer l'historique
  const historyRes = await receptionPool.query(
    `
    SELECT *
    FROM intervention_history
    WHERE intervention_id = $1
    ORDER BY created_at
    `,
    [id]
  );

  res.render('intervention_history', {
    intervention,
    history: historyRes.rows,
  });
});


// --- ÉDITER UNE INTERVENTION ---

// Formulaire d'édition
app.get('/interventions/:id/edit', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const client = await receptionPool.connect();

  try {
    const interventionRes = await client.query(
      `
      SELECT i.*,
             f.name AS floor_name,
             r.name AS room_name,
             c.id AS chantier_id,
             CASE
               WHEN c.nom IS NOT NULL AND c.nom <> '' THEN c.nom
               ELSE c.name
             END AS chantier_name
      FROM interventions i
      LEFT JOIN floors f ON i.floor_id = f.id
      LEFT JOIN rooms r ON i.room_id = r.id
      LEFT JOIN chantiers c ON f.chantier_id = c.id
      WHERE i.id = $1
      `,
      [id]
    );

    if (!interventionRes.rows.length) {
      return res.status(404).send("Intervention introuvable");
    }
    const intervention = interventionRes.rows[0];

    // on charge les étages / pièces du chantier
    const floors = (
      await client.query(
        `SELECT id, name FROM floors WHERE chantier_id = $1 ORDER BY name`,
        [intervention.chantier_id]
      )
    ).rows;

    const rooms = (
      await client.query(
        `
        SELECT r.id, r.name, r.floor_id, f.name AS floor_name
        FROM rooms r
        JOIN floors f ON r.floor_id = f.id
        WHERE f.chantier_id = $1
        ORDER BY f.name, r.name
        `,
        [intervention.chantier_id]
      )
    ).rows;

    // catalogue LOT / Tâche du chantier
    const catalogueLots = (
      await client.query(
        `
        SELECT DISTINCT lot
        FROM chantier_lot_tasks
        WHERE chantier_id = $1
        ORDER BY lot
        `,
        [intervention.chantier_id]
      )
    ).rows;

    const lotTasks = (
      await client.query(
        `
        SELECT lot, task
        FROM chantier_lot_tasks
        WHERE chantier_id = $1
        ORDER BY lot, task
        `,
        [intervention.chantier_id]
      )
    ).rows;

    res.render('intervention_edit', {
      chantier: {
        id: intervention.chantier_id,
        display_name: intervention.chantier_name,
      },
      intervention,
      floors,
      rooms,
      catalogueLots,
      lotTasks,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Erreur lors du chargement de l'intervention.");
  } finally {
    client.release();
  }
});

app.post('/interventions/:id/edit', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { floor_id, room_id, lot, task, persons, date } = req.body;
  const actor = req.session.user;

  if (!lot || !task) {
    return res.status(400).send("Lot et tâche sont obligatoires.");
  }

  const client = await receptionPool.connect();

  try {
    await client.query('BEGIN');

    const currentRes = await client.query(
      `
      SELECT i.*, f.chantier_id, f.name AS floor_name, r.name AS room_name
      FROM interventions i
      LEFT JOIN floors f ON i.floor_id = f.id
      LEFT JOIN rooms r ON i.room_id = r.id
      WHERE i.id = $1
      FOR UPDATE
      `,
      [id]
    );

    if (!currentRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).send("Intervention introuvable");
    }

    const current = currentRes.rows[0];

    // --- Gestion du "Qui ?" ---
    let personsArray = [];
    if (Array.isArray(persons)) {
      personsArray = persons.filter(p => p && p.trim().length > 0);
    } else if (typeof persons === 'string' && persons.trim().length > 0) {
      personsArray = [persons.trim()];
    }

    // si vide → on garde l'ancien person
    const newPerson = personsArray.length
      ? personsArray.join(', ')
      : current.person;

    const actorName =
      `${actor.prenom || ''} ${actor.nom || ''}`.trim() || actor.email;
    const dateText =
      (date && date.trim().length > 0
        ? date.trim()
        : new Date().toISOString().slice(0, 10));

    // --- Construire la note de correction Qui/Quand ---
    let correctionParts = [];
    if (personsArray.length) {
      correctionParts.push(`Qui = ${newPerson}`);
    }
    if (date) {
      correctionParts.push(`Quand = ${dateText}`);
    }
    const correctionText = correctionParts.length
      ? `Correction Qui/Quand le ${dateText} par ${actorName} (${correctionParts.join(' | ')})`
      : '';

    const newAction = correctionText
      ? ((current.action && current.action.length ? current.action + '\n' : '') + correctionText)
      : current.action;

    // --- Modifs sur lot / tâche / étage / pièce ---
    await client.query(
      `
      UPDATE interventions
      SET floor_id = $1,
          room_id = $2,
          lot     = $3,
          task    = $4,
          person  = $5,
          action  = $6
      WHERE id = $7
      `,
      [
        floor_id || null,
        room_id || null,
        lot,
        task,
        newPerson,
        newAction,
        id,
      ]
    );

    // --- Log dans l'historique ---
    const changes = [];

    if (current.lot !== lot) {
      changes.push(`Lot : « ${current.lot || ''} » → « ${lot} »`);
    }
    if (current.task !== task) {
      changes.push(`Tâche : « ${current.task || ''} » → « ${task} »`);
    }
    if (String(current.floor_id || '') !== String(floor_id || '')) {
      changes.push('Étage modifié');
    }
    if (String(current.room_id || '') !== String(room_id || '')) {
      changes.push('Pièce modifiée');
    }
    if (newPerson !== current.person) {
      changes.push(`Qui : « ${current.person || ''} » → « ${newPerson} »`);
    }
    if (date) {
      changes.push(`Quand fixé à ${dateText}`);
    }

    const note = changes.length
      ? `Modification de la tâche : ${changes.join(' | ')}`
      : 'Modification de la tâche (aucun changement visible)';

    await client.query(
      `
      INSERT INTO intervention_history (
        intervention_id, event_type,
        old_status, new_status,
        persons, date_event,
        actor_email, actor_name,
        note
      )
      VALUES ($1, 'edit',
              $2, $3,
              $4, $5,
              $6, $7,
              $8)
      `,
      [
        id,
        current.status,
        current.status,
        newPerson,
        dateText,
        actor.email,
        actorName,
        note,
      ]
    );

    await client.query('COMMIT');

    return res.redirect(`/chantiers/${current.chantier_id}/taches`);
  } catch (err) {
    console.error(err);
    await client.query('ROLLBACK');
    res.status(500).send("Erreur lors de la modification de l'intervention.");
  } finally {
    client.release();
  }
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

// Traitement de l'import Excel : alimente le catalogue LOT / Tâche POUR UN CHANTIER
app.post('/import', upload.single('fichier'), async (req, res) => {
  const chantierId = req.body.chantier_id;
  const filePath = req.file ? req.file.path : null;

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

  // Col A = LOT (peut être vide -> on reprend le dernier LOT non vide)
  // Col B = Tâche
  let currentLot = null;
  const pairs = new Set();

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    // Ligne 1 = en-tête "LOT | Travaux chambre ..."
    if (rowNumber === 1) return;

    const lotCell = row.getCell(1).value;
    const taskCell = row.getCell(2).value;

    const lot = lotCell ? String(lotCell).trim() : '';
    const task = taskCell ? String(taskCell).trim() : '';

    // si la cellule LOT est remplie on met à jour le "currentLot"
    if (lot) currentLot = lot;

    // si pas de lot courant ou pas de tâche -> on ignore
    if (!currentLot || !task) return;

    // on ignore la ligne de titre "Travaux chambre ...."
    if (/^travaux chambre/i.test(task)) return;

    const key = `${currentLot}|||${task}`;
    pairs.add(key);
  });

  const client = await receptionPool.connect();
  let inserted = 0;

  try {
    await client.query('BEGIN');

    // on efface le catalogue du chantier pour repartir propre
    await client.query(
      'DELETE FROM chantier_lot_tasks WHERE chantier_id = $1',
      [chantierId]
    );

    for (const key of pairs) {
      const [lot, task] = key.split('|||');

      await client.query(
        `
        INSERT INTO chantier_lot_tasks (chantier_id, lot, task)
        VALUES ($1, $2, $3)
        ON CONFLICT (chantier_id, lot, task) DO NOTHING
        `,
        [chantierId, lot, task]
      );
      inserted++;
    }

    await client.query('COMMIT');
  } catch (err) {
    console.error(err);
    await client.query('ROLLBACK');
    return res.status(500).render('import', {
      chantiers,
      message: null,
      error: "Erreur pendant l'import des LOTs / Tâches (voir logs serveur).",
    });
  } finally {
    client.release();
    fs.unlink(filePath, () => {});
  }

  const chantierLabel =
    chantiers.find((c) => String(c.id) === String(chantierId))?.display_name ||
    '';
  const chantierInfo = chantierLabel
    ? ` pour le chantier « ${chantierLabel} »`
    : '';

  return res.render('import', {
    chantiers,
    message: `Import terminé : ${inserted} couples LOT / Tâche enregistrés${chantierInfo}.`,
    error: null,
  });
});



// ----- DEMARRAGE ----- //
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
