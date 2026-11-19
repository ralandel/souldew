# Relais Nostr (mise en relation WebRTC)

Trystero, la bibliothèque qui établit les connexions directes entre joueurs, s'échange les offres de connexion via un
relais Nostr. Ces offres sont chiffrées avec la clé de la run, et ce sont des événements **éphémères** : le relais les
fait suivre en direct sans jamais les stocker. Docker est déjà installé sur le VPS, on utilise donc l'image de
[nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay).

Sans ce relais, souldew Renaissance fonctionne quand même : la sync passe par le broker MQTT, mais l'écran du partenaire
s'affiche en images fixes (toutes les 1,5 s) au lieu d'une vidéo, et les connexions directes ne s'établissent pas.

## Installation

```sh
mkdir -p /opt/souldew-nostr
# copier deploy/nostr/config.toml dans /opt/souldew-nostr/config.toml, puis :
docker run -d --name souldew-nostr --restart unless-stopped \
  -p 127.0.0.1:7777:8080 \
  -v /opt/souldew-nostr/config.toml:/usr/src/app/config.toml:ro \
  -v souldew-nostr-db:/usr/src/app/db \
  scsibug/nostr-rs-relay:latest
docker logs --tail 20 souldew-nostr      # doit afficher "listening on: 0.0.0.0:8080"
```

Le relais n'écoute qu'en local (`127.0.0.1:7777`). nginx le publie sur `wss://souldew.pkmnrenaissance.com/nostr` : ajouter
le bloc `location = /nostr { … }` de [`../nginx/souldew`](../nginx/souldew) dans `/etc/nginx/sites-available/souldew`
(dans le bloc `listen 443`, avant `location / { return 404; }`), puis `nginx -t && systemctl reload nginx`.

## Mettre à jour

```sh
docker pull scsibug/nostr-rs-relay:latest && docker rm -f souldew-nostr   # puis la commande docker run ci-dessus
```
