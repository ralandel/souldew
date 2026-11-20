; souldew's additions to electron-builder's NSIS installer (package.json build.nsis.include).
;
; 1. A second Start menu entry, "souldew (safe graphics)": the app started with --safe-graphics (shared/gpu.mjs) – drawn
;    without the graphics card, for a PC where souldew opens with a blank window. From there Settings › General switches
;    the graphics backend for the next normal start. Created next to the normal entry, removed with the app.
;
; 2. The privacy page (before the install starts): what souldew sends over the internet by itself, what the installer
;    changes on the PC, a link to the full policy (SD_POLICY_URL) and a checkbox for each of the two
;    automatic connections – the anonymous "playing now" count and the update check. Both are ticked as config.json has
;    them (on unless switched off in the app). What the player ticked goes into installer-choices.json in the data folder,
;    which the app applies once at its next start (electron/installerchoices.mjs). The page is never shown – and no file
;    written – for a silent install (/S, the in-app update) or an update started with --updated.
;    It sits in the one-click installer's slot for a license page (oneClick.nsh: skipPageIfUpdated + licensePage), so
;    package.json must not set build.nsis.license (makensis would stop on the second licensePage macro).
;
; 3. Uninstalling by hand (Settings › Apps, the Start menu) asks whether the player's data in %APPDATA%\souldew Renaissance
;    goes too – "No" is the default and keeps it. An update runs the old uninstaller with /S --updated: no question,
;    nothing deleted.
;
; Texts: English, German, French, Spanish and Italian; every other installer language gets the English text (makensis
; runs with -WX, so each string must exist in every language electron-builder bundles – test/installer-privacy.test.mjs).

!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh

; the data folder (electron/main.mjs: userData = %APPDATA%\<shared/edition.mjs dataFolder>) – souldew Renaissance's,
; never the official app's %APPDATA%\SoulLink Studio
!define SD_DATA_DIR "$APPDATA\souldew Renaissance"
!define SD_POLICY_URL "https://github.com/ralandel/souldew/blob/main/docs/PRIVACY.md"

; One text in all of electron-builder's installer languages: EN DE FR ES IT, English for the rest.
!macro SD_STR NAME EN DE FR ES IT
  LangString ${NAME} 1033 "${EN}"
  LangString ${NAME} 1031 "${DE}"
  LangString ${NAME} 1036 "${FR}"
  LangString ${NAME} 3082 "${ES}"
  LangString ${NAME} 1040 "${IT}"
  ; zh_CN zh_TW ja_JP ko_KR nl_NL da_DK sv_SE nb_NO fi_FI ru_RU pt_PT pt_BR pl_PL uk_UA cs_CZ sk_SK hu_HU ar_SA tr_TR th_TH vi_VN
  LangString ${NAME} 2052 "${EN}"
  LangString ${NAME} 1028 "${EN}"
  LangString ${NAME} 1041 "${EN}"
  LangString ${NAME} 1042 "${EN}"
  LangString ${NAME} 1043 "${EN}"
  LangString ${NAME} 1030 "${EN}"
  LangString ${NAME} 1053 "${EN}"
  LangString ${NAME} 1044 "${EN}"
  LangString ${NAME} 1035 "${EN}"
  LangString ${NAME} 1049 "${EN}"
  LangString ${NAME} 2070 "${EN}"
  LangString ${NAME} 1046 "${EN}"
  LangString ${NAME} 1045 "${EN}"
  LangString ${NAME} 1058 "${EN}"
  LangString ${NAME} 1029 "${EN}"
  LangString ${NAME} 1051 "${EN}"
  LangString ${NAME} 1038 "${EN}"
  LangString ${NAME} 1025 "${EN}"
  LangString ${NAME} 1055 "${EN}"
  LangString ${NAME} 1054 "${EN}"
  LangString ${NAME} 1066 "${EN}"
!macroend

!ifndef BUILD_UNINSTALLER
; ---- the privacy page ---------------------------------------------------------------------------------------------

!insertmacro SD_STR sdPrivTitle "Privacy" "Datenschutz" "Confidentialité" "Privacidad" "Privacy"
!insertmacro SD_STR sdPrivSub \
  "What souldew sends over the internet by itself" \
  "Was souldew von selbst über das Internet sendet" \
  "Ce que souldew envoie de lui-même sur Internet" \
  "Lo que souldew envía por sí solo a través de internet" \
  "Cosa invia souldew da solo tramite internet"
!insertmacro SD_STR sdPrivIntro \
  "souldew Renaissance collects no personal data and never talks to the official souldew servers. Only the update check (ticked below) goes out by itself – switch it off here or later in the settings." \
  "souldew Renaissance sammelt keine persönlichen Daten und spricht nie mit den Servern des offiziellen souldew. Von selbst geht nur die Update-Prüfung (unten angehakt) – hier oder später in den Einstellungen abschaltbar." \
  "souldew Renaissance ne collecte aucune donnée personnelle et ne contacte jamais les serveurs de souldew officiel. Seule la recherche de mises à jour (cochée ci-dessous) part d’elle-même – désactivable ici ou plus tard dans les paramètres." \
  "souldew Renaissance no recoge datos personales y nunca habla con los servidores del souldew oficial. Solo la búsqueda de actualizaciones (marcada abajo) sale por sí sola: puedes desactivarla aquí o más tarde en los ajustes." \
  "souldew Renaissance non raccoglie dati personali e non contatta mai i server del souldew ufficiale. Parte da solo soltanto il controllo aggiornamenti (spuntato qui sotto) – puoi disattivarlo qui o più tardi nelle impostazioni."
!insertmacro SD_STR sdPol1 \
  "PLAYING WITH THE OTHERS$\r$\nOnly while a run with other players is open: the run’s data, end-to-end encrypted, through the souldew Renaissance server (souldew.pkmnrenaissance.com), and directly between the players where possible. No “playing now” count, no account, no Discord bot of the official souldew." \
  "MIT DEN ANDEREN SPIELEN$\r$\nNur solange ein Run mit anderen offen ist: die Daten des Runs, Ende-zu-Ende verschlüsselt, über den Server von souldew Renaissance (souldew.pkmnrenaissance.com) und wenn möglich direkt zwischen den Spielern. Kein „Spielt gerade“-Zähler, kein Konto, kein Discord-Bot des offiziellen souldew." \
  "JOUER AVEC LES AUTRES$\r$\nUniquement quand une run avec d’autres joueurs est ouverte : les données de la run, chiffrées de bout en bout, via le serveur de souldew Renaissance (souldew.pkmnrenaissance.com), et directement entre les joueurs quand c’est possible. Pas de compteur « joue en ce moment », pas de compte, pas de bot Discord de souldew officiel." \
  "JUGAR CON LOS DEMÁS$\r$\nSolo mientras hay abierta una partida con otros jugadores: los datos de la partida, cifrados de extremo a extremo, a través del servidor de souldew Renaissance (souldew.pkmnrenaissance.com) y directamente entre los jugadores cuando es posible. Sin contador «jugando ahora», sin cuenta, sin el bot de Discord del souldew oficial." \
  "GIOCARE CON GLI ALTRI$\r$\nSolo mentre è aperta una run con altri giocatori: i dati della run, cifrati end-to-end, tramite il server di souldew Renaissance (souldew.pkmnrenaissance.com) e direttamente tra i giocatori quando possibile. Nessun contatore «sta giocando ora», nessun account, nessun bot Discord del souldew ufficiale."
!insertmacro SD_STR sdPol2 \
  "UPDATE CHECK$\r$\nAt start and every 4 hours souldew Renaissance asks GitHub (github.com/ralandel/souldew) whether there is a new version. Nothing about you is sent. When switched off, it only checks when you click “Check for updates” (Settings › About)." \
  "UPDATE-PRÜFUNG$\r$\nBeim Start und alle 4 Stunden fragt souldew Renaissance bei GitHub (github.com/ralandel/souldew) nach, ob es eine neue Version gibt. Dabei wird nichts über dich gesendet. Ausgeschaltet wird nur gesucht, wenn du auf „Nach Updates suchen“ klickst (Einstellungen › Info)." \
  "RECHERCHE DE MISES À JOUR$\r$\nAu démarrage puis toutes les 4 heures, souldew Renaissance demande à GitHub (github.com/ralandel/souldew) s’il existe une nouvelle version. Rien sur toi n’est envoyé. Désactivée, la recherche n’a lieu que lorsque tu cliques sur « Rechercher des mises à jour » (Paramètres › À propos)." \
  "BÚSQUEDA DE ACTUALIZACIONES$\r$\nAl iniciar y cada 4 horas, souldew Renaissance pregunta a GitHub (github.com/ralandel/souldew) si hay una versión nueva. No se envía nada sobre ti. Desactivada, solo se busca cuando pulsas «Buscar actualizaciones» (Ajustes › Acerca de)." \
  "CONTROLLO AGGIORNAMENTI$\r$\nAll’avvio e ogni 4 ore souldew Renaissance chiede a GitHub (github.com/ralandel/souldew) se c’è una nuova versione. Non viene inviato nulla su di te. Se disattivato, controlla solo quando clicchi su «Cerca aggiornamenti» (Impostazioni › Info)."
!insertmacro SD_STR sdPol3 \
  "PICTURES$\r$\nPokémon pictures and game covers are downloaded from public GitHub repositories (PokeAPI, libretro-thumbnails) and kept on this PC. These downloads carry nothing about you." \
  "BILDER$\r$\nPokémon-Bilder und Spiele-Cover werden aus öffentlichen GitHub-Repositorys (PokeAPI, libretro-thumbnails) geladen und auf diesem PC gespeichert. Diese Downloads enthalten nichts über dich." \
  "IMAGES$\r$\nLes images de Pokémon et les jaquettes des jeux sont téléchargées depuis des dépôts GitHub publics (PokeAPI, libretro-thumbnails) et gardées sur ce PC. Ces téléchargements ne contiennent rien sur toi." \
  "IMÁGENES$\r$\nLas imágenes de Pokémon y las portadas de los juegos se descargan de repositorios públicos de GitHub (PokeAPI, libretro-thumbnails) y se guardan en este PC. Estas descargas no contienen nada sobre ti." \
  "IMMAGINI$\r$\nLe immagini dei Pokémon e le copertine dei giochi vengono scaricate da repository GitHub pubblici (PokeAPI, libretro-thumbnails) e conservate su questo PC. Questi download non contengono nulla su di te."
!insertmacro SD_STR sdPol4 \
  "ONLY WHEN YOU USE THEM$\r$\nDiscord webhooks you set up yourself and downloading the randomizer or an emulator connect only when you use them, and send only what they need." \
  "NUR WENN DU SIE NUTZT$\r$\nDiscord-Webhooks, die du selbst einrichtest, sowie der Download des Randomizers oder eines Emulators verbinden sich nur, wenn du sie nutzt, und senden nur, was sie brauchen." \
  "SEULEMENT QUAND TU LES UTILISES$\r$\nLes webhooks Discord que tu configures toi-même, ainsi que le téléchargement du randomizer ou d’un émulateur, ne se connectent que quand tu les utilises, et n’envoient que ce dont ils ont besoin." \
  "SOLO CUANDO LOS USAS$\r$\nLos webhooks de Discord que configuras tú mismo y la descarga del randomizer o de un emulador solo se conectan cuando los usas, y solo envían lo que necesitan." \
  "SOLO QUANDO LI USI$\r$\nI webhook Discord che configuri tu e il download del randomizer o di un emulatore si connettono solo quando li usi, e inviano solo ciò che serve."
!insertmacro SD_STR sdPol5 \
  "WHAT THIS INSTALLER CHANGES$\r$\nsouldew Renaissance is installed for you only, without administrator rights, in %LOCALAPPDATA%\Programs\souldew Renaissance, next to the official souldew if you have it. It adds “souldew Renaissance” and “souldew Renaissance (safe graphics)” to the Start menu, a desktop shortcut, and an entry under Settings › Apps to uninstall it. No file types, no web links, no services, no autostart. Your data stays in %APPDATA%\souldew Renaissance – uninstalling asks whether to delete it." \
  "WAS DIESES SETUP VERÄNDERT$\r$\nsouldew Renaissance wird nur für dich installiert, ohne Administratorrechte, in %LOCALAPPDATA%\Programs\souldew Renaissance, neben einem offiziellen souldew, falls vorhanden. Es legt „souldew Renaissance“ und „souldew Renaissance (safe graphics)“ im Startmenü an, eine Verknüpfung auf dem Desktop und einen Eintrag unter Einstellungen › Apps zum Deinstallieren. Keine Dateitypen, keine Weblinks, keine Dienste, kein Autostart. Deine Daten bleiben in %APPDATA%\souldew Renaissance – beim Deinstallieren wirst du gefragt, ob sie gelöscht werden sollen." \
  "CE QUE CET INSTALLATEUR MODIFIE$\r$\nsouldew Renaissance est installé pour toi seul, sans droits d’administrateur, dans %LOCALAPPDATA%\Programs\souldew Renaissance, à côté de souldew officiel si tu l’as. Il ajoute « souldew Renaissance » et « souldew Renaissance (safe graphics) » au menu Démarrer, un raccourci sur le bureau et une entrée dans Paramètres › Applications pour le désinstaller. Aucun type de fichier, aucun lien web, aucun service, aucun démarrage automatique. Tes données restent dans %APPDATA%\souldew Renaissance – la désinstallation demande s’il faut les supprimer." \
  "QUÉ CAMBIA ESTE INSTALADOR$\r$\nsouldew Renaissance se instala solo para ti, sin derechos de administrador, en %LOCALAPPDATA%\Programs\souldew Renaissance, junto al souldew oficial si lo tienes. Añade «souldew Renaissance» y «souldew Renaissance (safe graphics)» al menú Inicio, un acceso directo en el escritorio y una entrada en Configuración › Aplicaciones para desinstalarlo. Ningún tipo de archivo, ningún enlace web, ningún servicio, ningún inicio automático. Tus datos se quedan en %APPDATA%\souldew Renaissance; al desinstalar se te pregunta si quieres borrarlos." \
  "COSA CAMBIA QUESTO INSTALLER$\r$\nsouldew Renaissance viene installato solo per te, senza diritti di amministratore, in %LOCALAPPDATA%\Programs\souldew Renaissance, accanto al souldew ufficiale se ce l’hai. Aggiunge «souldew Renaissance» e «souldew Renaissance (safe graphics)» al menu Start, un collegamento sul desktop e una voce in Impostazioni › App per disinstallarlo. Nessun tipo di file, nessun link web, nessun servizio, nessun avvio automatico. I tuoi dati restano in %APPDATA%\souldew Renaissance – disinstallando ti viene chiesto se eliminarli."
!insertmacro SD_STR sdChkUpdates \
  "Check for updates automatically" \
  "Automatisch nach Updates suchen" \
  "Rechercher automatiquement les mises à jour" \
  "Buscar actualizaciones automáticamente" \
  "Cerca aggiornamenti automaticamente"
!insertmacro SD_STR sdPolicyLink \
  "Read the full privacy notes (docs/PRIVACY.md on GitHub)" \
  "Ganze Datenschutzhinweise lesen (docs/PRIVACY.md auf GitHub)" \
  "Lire les détails sur la confidentialité (docs/PRIVACY.md sur GitHub)" \
  "Leer las notas de privacidad completas (docs/PRIVACY.md en GitHub)" \
  "Leggi le note complete sulla privacy (docs/PRIVACY.md su GitHub)"

Var sdPrivacyShown ; "1" once the player left the page with "Install"
Var sdPresence ; "true" / "false": the boxes when "Install" was clicked …
Var sdUpdateCheck
Var sdPresenceShown ; … and when the page opened (config.json's state)
Var sdUpdateCheckShown
Var sdChkUpdate

; config.json's state of the two settings: off only when switched off ("presence": false / "updateCheck": false as a
; top-level key – the app writes the file with two-space indentation, one key per line)
Function sdReadConfig
  StrCpy $sdPresenceShown "true"
  StrCpy $sdUpdateCheckShown "true"
  ClearErrors
  FileOpen $0 "${SD_DATA_DIR}\config.json" r
  ${IfNot} ${Errors}
    ${Do}
      ClearErrors
      FileRead $0 $1
      ${If} ${Errors}
        ${ExitDo}
      ${EndIf}
      StrCpy $2 $1 19
      ${If} $2 == '  "presence": false'
        StrCpy $sdPresenceShown "false"
      ${EndIf}
      StrCpy $2 $1 22
      ${If} $2 == '  "updateCheck": false'
        StrCpy $sdUpdateCheckShown "false"
      ${EndIf}
    ${Loop}
    FileClose $0
  ${EndIf}
FunctionEnd

Function sdOpenPolicy
  Pop $0 ; the link's window
  ExecShell "open" "${SD_POLICY_URL}"
FunctionEnd

; oneClick.nsh inserts this (after skipPageIfUpdated) right before the install starts.
!macro licensePage
  ; skipPageIfUpdated defined MUI_PAGE_CUSTOMFUNCTION_PRE for the next MUI page – a plain custom page doesn't use it, and
  ; left defined it would go to MUI_PAGE_INSTFILES and skip the install itself on an update. The page skips itself.
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !define SD_SKIP_FN ${MUI_PAGE_CUSTOMFUNCTION_PRE}
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif

  Function sdPrivacyCreate
    !ifdef SD_SKIP_FN
      GetFunctionAddress $0 ${SD_SKIP_FN} ; (referenced, so makensis -WX doesn't stop on an unused function)
    !endif
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    ${If} $sdPresenceShown == ""
      ${If} $installMode == "all"
        SetShellVarContext current
      ${EndIf}
      Call sdReadConfig
      ${If} $installMode == "all"
        SetShellVarContext all
      ${EndIf}
      StrCpy $sdPresence $sdPresenceShown
      StrCpy $sdUpdateCheck $sdUpdateCheckShown
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "$(sdPrivTitle)" "$(sdPrivSub)"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 20u "$(sdPrivIntro)"
    Pop $0
    ; the policy itself, read-only and scrollable
    nsDialogs::CreateControl EDIT ${DEFAULT_STYLES}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL} ${WS_EX_CLIENTEDGE} 0 22u 100% 72u ""
    Pop $0
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(sdPol1)$\r$\n$\r$\n$(sdPol2)$\r$\n$\r$\n$(sdPol3)$\r$\n$\r$\n$(sdPol4)$\r$\n$\r$\n$(sdPol5)"

    ; (souldew Renaissance: no "playing now" box – this build never sends the count, shared/edition.mjs presence: false;
    ; $sdPresence stays as config.json has it, so the app changes nothing)
    ${NSD_CreateCheckBox} 0 103u 100% 11u "$(sdChkUpdates)"
    Pop $sdChkUpdate
    ${If} $sdUpdateCheck == "true"
      ${NSD_Check} $sdChkUpdate
    ${EndIf}

    ${NSD_CreateLink} 0 125u 100% 11u "$(sdPolicyLink)"
    Pop $0
    ${NSD_OnClick} $0 sdOpenPolicy

    ; the next step is the install itself
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(^InstallBtn)"
    nsDialogs::Show
  FunctionEnd

  Function sdPrivacyLeave
    ${NSD_GetState} $sdChkUpdate $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $sdUpdateCheck "true"
    ${Else}
      StrCpy $sdUpdateCheck "false"
    ${EndIf}
    StrCpy $sdPrivacyShown "1"
  FunctionEnd

  Page custom sdPrivacyCreate sdPrivacyLeave
!macroend

; The choices for the app (electron/installerchoices.mjs) – only when the page was shown and left with "Install".
!macro sdWriteChoices
  ${If} $sdPrivacyShown == "1"
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    CreateDirectory "${SD_DATA_DIR}"
    ClearErrors
    FileOpen $0 "${SD_DATA_DIR}\installer-choices.json" w
    ${IfNot} ${Errors}
      FileWrite $0 '{"v":1,"presence":$sdPresence,"presenceShown":$sdPresenceShown,"updateCheck":$sdUpdateCheck,"updateCheckShown":$sdUpdateCheckShown}'
      FileClose $0
    ${EndIf}
    ClearErrors
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
!endif

!ifdef BUILD_UNINSTALLER
!insertmacro SD_STR sdUnDeleteData \
  "Also delete your souldew Renaissance data?$\r$\n$\r$\nYour runs, saves, save states, settings, trophies and the games in the library are in %APPDATA%\souldew Renaissance (the official souldew’s data is not touched).$\r$\n$\r$\nNo: they stay on this PC, and installing souldew Renaissance again picks them up.$\r$\nYes: that folder is deleted for good." \
  "Auch deine Daten von souldew Renaissance löschen?$\r$\n$\r$\nDeine Runs, Spielstände, Savestates, Einstellungen, Trophäen und die Spiele in der Bibliothek liegen in %APPDATA%\souldew Renaissance (die Daten des offiziellen souldew bleiben unberührt).$\r$\n$\r$\nNein: Sie bleiben auf diesem PC, und eine neue Installation findet sie wieder.$\r$\nJa: Dieser Ordner wird endgültig gelöscht." \
  "Supprimer aussi tes données souldew Renaissance ?$\r$\n$\r$\nTes runs, sauvegardes, états de sauvegarde, paramètres, trophées et les jeux de la bibliothèque se trouvent dans %APPDATA%\souldew Renaissance (les données de souldew officiel ne sont pas touchées).$\r$\n$\r$\nNon : elles restent sur ce PC, et une nouvelle installation les retrouve.$\r$\nOui : ce dossier est supprimé définitivement." \
  "¿Borrar también tus datos de souldew Renaissance?$\r$\n$\r$\nTus runs, partidas guardadas, estados guardados, ajustes, trofeos y los juegos de la biblioteca están en %APPDATA%\souldew Renaissance (los datos del souldew oficial no se tocan).$\r$\n$\r$\nNo: se quedan en este PC y una nueva instalación los vuelve a encontrar.$\r$\nSí: esa carpeta se borra para siempre." \
  "Eliminare anche i tuoi dati di souldew Renaissance?$\r$\n$\r$\nLe tue run, i salvataggi, gli stati salvati, le impostazioni, i trofei e i giochi della libreria si trovano in %APPDATA%\souldew Renaissance (i dati del souldew ufficiale non vengono toccati).$\r$\n$\r$\nNo: restano su questo PC e una nuova installazione li ritrova.$\r$\nSì: quella cartella viene eliminata definitivamente."

Var sdDeleteData ; "1": the player said yes to deleting the data folder

; After the one-click uninstaller's "Are you sure …?" (un.onInit): only an uninstall by hand asks – not /S (an update runs
; the old uninstaller with /S --updated, Windows' "quiet uninstall" with /S) and not --updated. "No" is the default.
!macro customUnInit
  StrCpy $sdDeleteData "0"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/S" $R1
  ${If} ${Errors}
  ${AndIfNot} ${isUpdated}
    SetShellVarContext current
    ${If} ${FileExists} "${SD_DATA_DIR}\*.*"
      ; the one-click uninstaller has already switched itself to silent (after its "Are you sure …?"), and a silent
      ; MessageBox answers /SD on its own without showing – so speak up for this one question, then back to silent
      SetSilent normal
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(sdUnDeleteData)" /SD IDNO IDNO +2
      StrCpy $sdDeleteData "1"
      SetSilent silent
    ${EndIf}
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend
!endif

!macro customInstall
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME} (safe graphics).lnk" "$appExe" "--safe-graphics" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$SMPROGRAMS\${SHORTCUT_NAME} (safe graphics).lnk" "${APP_ID}"
  ClearErrors
  !insertmacro sdWriteChoices
!macroend

!macro customUnInstall
  ; an update uninstalls the old version first and installs the shortcut again right after
  WinShell::UninstShortcut "$SMPROGRAMS\${SHORTCUT_NAME} (safe graphics).lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME} (safe graphics).lnk"
  ClearErrors
  ; the player's data – only after a "Yes" to the question above (never on an update)
  ${If} $sdDeleteData == "1"
    SetShellVarContext current
    RMDir /r "${SD_DATA_DIR}"
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
    ClearErrors
  ${EndIf}
!macroend
