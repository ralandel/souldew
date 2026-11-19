# Serveur de souldew Renaissance

Tout ce qui tourne sur le VPS (Debian 13) pour la sync de **souldew Renaissance**, à l'adresse
`souldew.pkmnrenaissance.com` (enregistrement A vers l'IP du VPS, chez PulseHeberg).
Les adresses utilisées par l'app sont définies dans [`shared/edition.mjs`](../shared/edition.mjs).

Le serveur n'héberge **ni les ROMs ni les sauvegardes**. Il transporte et conserve l'état des runs, chiffré de bout en bout
(AES-GCM, avec une clé que seuls les joueurs de la run possèdent).

| Service | Adresse publique | Rôle | Fichiers |
|---|---|---|---|
| nginx (déjà présent) | `https://souldew.pkmnrenaissance.com` | TLS + proxy WebSocket, `/` répond 404 | [`nginx/souldew`](nginx/souldew) |
| Mosquitto | `wss://…/mqtt` | Broker MQTT : sync des runs et codes d'invitation, état conservé (messages retained) | [`mosquitto/`](mosquitto) |
| Relais Nostr | `wss://…/nostr` | Mise en relation WebRTC (Trystero) – événements éphémères, rien n'est stocké | [`nostr/`](nostr) |
| coturn | `turn:…:3478`, `turns:…:5349` | STUN/TURN : relaie les joueurs qui ne peuvent pas se connecter en direct | [`coturn/`](coturn) |

Le site `renaissance-api` (l'API sur `api.pkmnrenaissance.com`) partage le même nginx : **ne jamais le modifier**.
souldew n'ajoute qu'un fichier de site à part, avec son propre `server_name`.

## Ports

`ufw` est **inactif** sur ce VPS (ne pas l'activer sans y autoriser d'abord le port SSH et tout ce qu'utilise l'API).
Ports utilisés par souldew : 80/443 (nginx), 3478 UDP+TCP, 5349 TCP, 49152–49252 UDP (relais TURN).
Mosquitto (9001, 1883) et le relais Nostr (7777) n'écoutent qu'en local.

## Installation (déjà faite le 19/11/2026, sauf le relais Nostr)

Avant toute installation : `echo "\$nrconf{restart} = 'l';" > /etc/needrestart/conf.d/no-auto-restart.conf`
(sinon `apt` redémarre tout seul mongod et nginx, donc l'API).

1. **Mosquitto** : `apt install -y mosquitto mosquitto-clients`, copier `mosquitto/souldew.conf` dans
   `/etc/mosquitto/conf.d/` et `mosquitto/souldew.acl` dans `/etc/mosquitto/`, puis `systemctl restart mosquitto`.
   L'ACL n'autorise que les topics `souldew/#` (l'app utilise `souldew/renaissance/…`).
2. **nginx + certificat** : copier `nginx/souldew` dans `/etc/nginx/sites-available/`, faire le lien dans
   `sites-enabled/`, puis `nginx -t && systemctl reload nginx` et
   `apt install -y python3-certbot-nginx && certbot --nginx -d souldew.pkmnrenaissance.com --redirect`.
3. **coturn** : `apt install -y coturn`, copier `coturn/turnserver.conf` dans `/etc/turnserver.conf` en y mettant le mot de
   passe (le même que `credential` dans `shared/edition.mjs`), copier `coturn/coturn-cert-hook.sh` dans
   `/etc/letsencrypt/renewal-hooks/deploy/coturn.sh` (`chmod +x`), le lancer une fois, puis `systemctl enable --now coturn`.
4. **Relais Nostr** (à faire) : voir [`nostr/README.md`](nostr/README.md).

## Vérifier

- Broker : `mosquitto_sub -h 127.0.0.1 -t 'souldew/#' -v` sur le VPS affiche le trafic (chiffré) des runs en cours.
- TURN : page [Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) avec
  `turn:souldew.pkmnrenaissance.com:3478`, utilisateur `souldew` → une ligne `relay` doit apparaître.
- Certificats : `certbot certificates` (renouvellement automatique ; le hook recopie le certificat pour coturn).

## Identifiants

L'identifiant TURN est intégré à l'app, il est donc public. Les quotas (`user-quota`, `total-quota`) et les
`denied-peer-ip` (pas d'accès aux réseaux privés, ni aux conteneurs Docker du VPS) limitent les abus. Pour le changer :
modifier `/etc/turnserver.conf` et `shared/edition.mjs`, puis publier une nouvelle version de l'app.
