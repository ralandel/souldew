#!/bin/sh
# /etc/letsencrypt/renewal-hooks/deploy/coturn.sh – coturn can't read /etc/letsencrypt/live (root only): copy the
# certificate for it after every renewal, then restart it.
D=/etc/letsencrypt/live/souldew.pkmnrenaissance.com
install -d -o turnserver -g turnserver /etc/coturn/certs
install -m 644 -o turnserver -g turnserver "$D/fullchain.pem" /etc/coturn/certs/
install -m 600 -o turnserver -g turnserver "$D/privkey.pem"   /etc/coturn/certs/
systemctl restart coturn
