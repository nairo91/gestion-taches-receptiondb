# Mise en place rapide

Variables d'environnement attendues :

- `RECEPTION_DB_URL` : URL Postgres de la base reception-db (Internal Database URL Render).
- `SESSION_SECRET` : une chaîne aléatoire pour les sessions.
- `USERS_CSV_PATH` : chemin vers le fichier des utilisateurs (par défaut `./users.csv`).

Commandes :

- `npm install`
- `npm start`

Endpoints principaux :

- `/login` : connexion (via users.csv).
- `/` : liste des chantiers.
- `/chantiers/:id/taches` : suivi des interventions par chantier.
- `/import` : import d'un fichier Excel (A: étage, B: pièce, C: lot, D: tâche).
