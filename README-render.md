# Déploiement rapide (Render)

Variables d'environnement :

- `RECEPTION_DB_URL` : URL Postgres (Internal sur Render).
- `SESSION_SECRET` : chaîne secrète.
- `USERS_CSV_PATH` : chemin du fichier CSV (par défaut `./users.csv`).
- `DB_SSL` : à mettre à `true` uniquement en local si vous utilisez l'External URL.

Commandes :

- Build : `npm install`
- Start : `npm start`
