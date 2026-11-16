' Cena principal: menu, fileiras, detalhe, busca, TV ao vivo e player.
' Regra do dono: o público só vê o vídeo. Nenhuma mensagem aqui cita servidor, fonte ou motivo técnico.

sub init()
  m.menu = m.top.findNode("menu")
  m.rows = m.top.findNode("rows")
  m.detail = m.top.findNode("detail")
  m.player = m.top.findNode("player")
  m.loading = m.top.findNode("loading")
  m.empty = m.top.findNode("empty")
  m.busyLayer = m.top.findNode("busyLayer")
  m.busyText = m.top.findNode("busyText")

  m.menu.buttons = ["Início", "Filmes", "Séries", "TV ao vivo", "Buscar"]
  m.menu.observeField("buttonSelected", "onMenu")
  m.rows.observeField("rowItemSelected", "onItemPick")
  m.rows.observeField("rowItemFocused", "onRowFocus")
  m.detail.observeField("playRequest", "onPlayRequest")
  m.detail.observeField("closed", "onDetailClosed")
  m.player.observeField("state", "onPlayerState")
  m.player.observeField("duration", "onPlayerDuration")

  m.movieRows = { "popular-movies": 1, "top-movies": 1, "now-playing": 1, "g-action": 1, "g-comedy": 1, "g-horror": 1, "g-scifi": 1, "upcoming": 1, "g-animation": 1, "g-romance": 1, "g-thriller": 1, "g-crime": 1, "g-adventure": 1, "g-family": 1, "g-docs": 1 }
  m.tvRows = { "popular-tv": 1, "top-tv": 1, "airing": 1, "tv-drama": 1, "tv-comedy": 1, "tv-anime": 1 }

  m.mode = "browse"        ' browse | detail | player
  m.tab = 0
  m.loadToken = 0
  m.rowQueue = []
  m.rowNext = 0
  m.rowBusy = false
  m.rowsShown = 0
  m.homeRows = invalid
  m.play = invalid
  m.langByTitle = {}
  m.menu.setFocus(true)
  loadTab(0)
end sub

' ---------------------------------------------------------------- abas

sub onMenu()
  loadTab(m.menu.buttonSelected)
end sub

sub loadTab(idx as integer)
  m.tab = idx
  m.loadToken = m.loadToken + 1
  m.rowQueue = []
  m.rowNext = 0
  m.rowBusy = false
  m.rowsShown = 0
  m.rowRoot = CreateObject("roSGNode", "ContentNode")
  m.rows.visible = false
  m.empty.visible = false
  m.focusRowsWhenReady = (m.mode = "browse")

  if idx = 4
    m.loading.visible = false
    openSearch()
  else if idx = 3
    m.loading.visible = true
    apiGet("/api/live/channels", "onLive", m.loadToken.toStr())
  else
    m.loading.visible = true
    if m.homeRows = invalid
      apiGet("/api/home", "onHome", m.loadToken.toStr())
    else
      buildQueue()
    end if
  end if
end sub

sub onHome(event as object)
  res = event.getData()
  if res = invalid or res.tag <> m.loadToken.toStr() then return
  if res.ok and res.data <> invalid and res.data.rows <> invalid
    m.homeRows = res.data.rows
    buildQueue()
  else
    showEmpty("Não foi possível carregar agora. Aperte OK em uma aba para tentar de novo.")
  end if
end sub

sub buildQueue()
  q = []
  for each r in m.homeRows
    if m.tab = 0
      q.push(r)
    else if m.tab = 1 and m.movieRows[r.id] <> invalid
      q.push(r)
    else if m.tab = 2 and m.tvRows[r.id] <> invalid
      q.push(r)
    end if
  end for
  m.rowQueue = q
  m.rowNext = 0
  loadNextRow()
  loadNextRow()
end sub

sub loadNextRow()
  if m.rowBusy or m.rowNext >= m.rowQueue.count() then return
  m.rowBusy = true
  def = m.rowQueue[m.rowNext]
  m.rowNext = m.rowNext + 1
  apiGet("/api/row?id=" + urlEnc(def.id), "onRow", m.loadToken.toStr() + "|" + def.title)
end sub

sub onRow(event as object)
  res = event.getData()
  if res = invalid then return
  sep = Instr(1, res.tag, "|")
  if sep < 1 then return
  if Left(res.tag, sep - 1) <> m.loadToken.toStr() then return
  title = Mid(res.tag, sep + 1)
  m.rowBusy = false
  if res.ok and res.data <> invalid and res.data.results <> invalid and res.data.results.count() > 0
    row = CreateObject("roSGNode", "ContentNode")
    row.title = title
    for each it in res.data.results
      big = posterUrl(it.poster, "w342")
      small = posterUrl(it.poster, "w185")
      year = ""
      if it.year <> invalid then year = it.year
      ov = ""
      if it.overview <> invalid then ov = it.overview
      row.appendChild(makeItem(it.type, it.id, it.title, small, big, year, ov, it.rating))
    end for
    addRow(row)
  end if
  if m.rowNext < m.rowQueue.count() and m.rowsShown < 3 then loadNextRow()
  if m.rowsShown = 0 and m.rowNext >= m.rowQueue.count() then showEmpty("Nada para mostrar agora.")
end sub

sub addRow(row as object)
  m.rowRoot.appendChild(row)
  m.rowsShown = m.rowsShown + 1
  if m.rowsShown = 1
    m.rows.content = m.rowRoot
    m.rows.visible = true
    m.loading.visible = false
    m.empty.visible = false
    if m.focusRowsWhenReady and m.mode = "browse" then m.rows.setFocus(true)
  end if
end sub

sub showEmpty(text as string)
  m.loading.visible = false
  m.rows.visible = false
  m.empty.text = text
  m.empty.visible = true
end sub

' Carrega mais fileiras conforme a pessoa desce.
sub onRowFocus()
  f = m.rows.rowItemFocused
  if f = invalid then return
  if f[0] >= m.rowsShown - 2 and m.tab < 3 then loadNextRow()
end sub

' ---------------------------------------------------------------- TV ao vivo

sub onLive(event as object)
  res = event.getData()
  if res = invalid or res.tag <> m.loadToken.toStr() then return
  if not res.ok or res.data = invalid or res.data.channels = invalid
    showEmpty("Não foi possível carregar agora.")
    return
  end if
  root = CreateObject("roSGNode", "ContentNode")
  groups = res.data.groups
  if groups = invalid then groups = []
  for each g in groups
    row = CreateObject("roSGNode", "ContentNode")
    row.title = g
    for each ch in res.data.channels
      if ch.group = g and ch.status <> "down"
        logo = ""
        if type(ch.logo) = "roString" or type(ch.logo) = "String"
          logo = ch.logo
          if Left(logo, 4) <> "http" then logo = m.global.apiBase + logo
        end if
        row.appendChild(makeItem("live", ch.id, ch.name, logo, logo, "", "", invalid))
      end if
    end for
    if row.getChildCount() > 0 then root.appendChild(row)
  end for
  if root.getChildCount() = 0
    showEmpty("Nenhum canal disponível agora.")
    return
  end if
  m.rowsShown = root.getChildCount()
  m.rows.content = root
  m.rows.visible = true
  m.loading.visible = false
  if m.focusRowsWhenReady and m.mode = "browse" then m.rows.setFocus(true)
end sub

' ---------------------------------------------------------------- busca

sub openSearch()
  dlg = CreateObject("roSGNode", "KeyboardDialog")
  dlg.title = "Buscar filmes e séries"
  dlg.buttons = ["Buscar", "Cancelar"]
  dlg.observeFieldScoped("buttonSelected", "onSearchButton")
  m.top.dialog = dlg
end sub

sub onSearchButton(event as object)
  dlg = event.getRoSGNode()
  idx = event.getData()
  text = dlg.text
  dlg.close = true
  if idx = 0 and Len(text) > 0
    m.loading.visible = true
    m.loadToken = m.loadToken + 1
    apiGet("/api/search?q=" + urlEnc(text), "onSearch", m.loadToken.toStr() + "|" + text)
  else
    m.menu.setFocus(true)
  end if
end sub

sub onSearch(event as object)
  res = event.getData()
  if res = invalid then return
  sep = Instr(1, res.tag, "|")
  if sep < 1 or Left(res.tag, sep - 1) <> m.loadToken.toStr() then return
  m.loading.visible = false
  movies = CreateObject("roSGNode", "ContentNode")
  movies.title = "Filmes"
  shows = CreateObject("roSGNode", "ContentNode")
  shows.title = "Séries"
  if res.ok and res.data <> invalid and res.data.results <> invalid
    for each it in res.data.results
      if it.poster <> invalid and it.poster <> ""
        year = ""
        if it.year <> invalid then year = it.year
        ov = ""
        if it.overview <> invalid then ov = it.overview
        node = makeItem(it.type, it.id, it.title, posterUrl(it.poster, "w185"), posterUrl(it.poster, "w342"), year, ov, it.rating)
        if it.type = "tv" then shows.appendChild(node) else movies.appendChild(node)
      end if
    end for
  end if
  root = CreateObject("roSGNode", "ContentNode")
  if movies.getChildCount() > 0 then root.appendChild(movies)
  if shows.getChildCount() > 0 then root.appendChild(shows)
  if root.getChildCount() = 0
    showEmpty("Nada encontrado para " + Mid(res.tag, sep + 1) + ".")
    m.menu.setFocus(true)
    return
  end if
  m.rowsShown = root.getChildCount()
  m.rows.content = root
  m.rows.visible = true
  m.empty.visible = false
  m.rows.setFocus(true)
end sub

' ---------------------------------------------------------------- escolher um item

sub onItemPick()
  sel = m.rows.rowItemSelected
  if sel = invalid or m.rows.content = invalid then return
  node = m.rows.content.getChild(sel[0]).getChild(sel[1])
  if node = invalid then return
  colon = Instr(1, node.id, ":")
  kind = Left(node.id, colon - 1)
  id = Mid(node.id, colon + 1)
  if kind = "live"
    startLive(id, node.title)
  else
    m.mode = "detail"
    m.menu.visible = false
    m.rows.visible = false
    m.detail.visible = true
    m.detail.item = { type: kind, id: id, title: node.title, year: node.ReleaseDate, overview: node.Description, poster: node.HDBackgroundImageUrl }
    m.detail.setFocus(true)
  end if
end sub

sub onDetailClosed()
  m.detail.visible = false
  m.menu.visible = true
  m.rows.visible = true
  m.mode = "browse"
  m.rows.setFocus(true)
end sub

' ---------------------------------------------------------------- tocar (filme / episódio)

sub onPlayRequest(event as object)
  req = event.getData()
  if req = invalid then return
  m.play = { live: false, type: req.type, id: req.id, s: req.s, e: req.e, title: req.title, skip: [], pick: "", lang: "", autoSwitches: 0, resume: 0, expectMin: 0, curSrc: "", curSv: "", tries: 0 }
  showBusy("Carregando…")
  path = "/api/stream/options?id=" + req.id + "&type=" + req.type + "&s=" + req.s.toStr() + "&e=" + req.e.toStr() + "&hevc=0&title=" + urlEnc(req.title)
  apiGet(path, "onOptions", "opt")
end sub

sub onOptions(event as object)
  if m.play = invalid then return
  res = event.getData()
  opts = []
  if res <> invalid and res.ok and res.data <> invalid and res.data.options <> invalid then opts = res.data.options
  if opts.count() >= 2
    hideBusy()
    m.opts = opts
    remembered = m.langByTitle[m.play.id]
    if remembered <> invalid
      choose(remembered)
      return
    end if
    showDialog("Escolha o áudio", "Este título tem duas versões.", ["Dublado em português", "Original com legenda"], "onLangPick")
  else if opts.count() = 1
    m.play.pick = opts[0].pick
    m.play.lang = opts[0].lang
    requestStream()
  else
    requestStream()
  end if
end sub

sub onLangPick(event as object)
  idx = event.getData()
  closeDialog()
  if idx = 0 then choose("dub") else choose("orig")
end sub

sub choose(lang as string)
  m.langByTitle[m.play.id] = lang
  for each o in m.opts
    if o.lang = lang
      m.play.pick = o.pick
      m.play.lang = o.lang
    end if
  end for
  showBusy("Carregando…")
  requestStream()
end sub

sub requestStream()
  showBusy("Carregando…")
  p = m.play
  path = "/api/stream?id=" + p.id + "&type=" + p.type + "&hevc=0&title=" + urlEnc(p.title)
  if p.type = "tv" then path = path + "&s=" + p.s.toStr() + "&e=" + p.e.toStr()
  if p.pick <> "" then path = path + "&pick=" + p.pick
  if p.skip.count() > 0 then path = path + "&fresh=1&skip=" + joinList(p.skip, ",")
  apiGet(path, "onStream", "stream")
end sub

sub onStream(event as object)
  if m.play = invalid then return
  res = event.getData()
  if res = invalid or not res.ok or res.data = invalid or res.data.url = invalid
    hideBusy()
    if m.play.skip.count() > 0
      ' não há outra versão: libera as descartadas e volta
      m.play.skip = []
      showDialog("Outra versão", "Não achei outra versão deste título agora.", ["Tentar de novo", "Voltar"], "onFailPick")
    else
      showDialog("Não foi possível abrir", "Tente novamente em instantes.", ["Tentar de novo", "Voltar"], "onFailPick")
    end if
    return
  end if
  d = res.data
  if d.src <> invalid then m.play.curSrc = d.src
  if d.sv <> invalid then m.play.curSv = d.sv
  if d.expectMin <> invalid then m.play.expectMin = d.expectMin
  m.play.pick = ""
  startVideo(d.url, d.mode, d.captions)
end sub

sub onFailPick(event as object)
  idx = event.getData()
  closeDialog()
  if idx = 0
    requestStream()
  else
    closePlayer()
  end if
end sub

' ---------------------------------------------------------------- TV ao vivo: tocar

sub startLive(id as string, title as string)
  m.play = { live: true, ch: id, title: title, skip: [], tries: 0 }
  showBusy("Carregando…")
  requestLive()
end sub

sub requestLive()
  path = "/api/live/stream?ch=" + urlEnc(m.play.ch)
  if m.play.skip.count() > 0 then path = path + "&skip=" + joinList(m.play.skip, ",")
  apiGet(path, "onLiveStream", "live")
end sub

sub onLiveStream(event as object)
  if m.play = invalid or not m.play.live then return
  res = event.getData()
  ok = (res <> invalid and res.ok and res.data <> invalid and res.data.url <> invalid)
  if ok and res.data.mode = "page"
    ' página de player com anúncios: o Roku não renderiza página; pede a próxima fonte do canal
    m.play.tries = m.play.tries + 1
    if res.data.sid <> invalid then m.play.skip.push(res.data.sid)
    if m.play.tries < 4
      requestLive()
      return
    end if
    ok = false
  end if
  if not ok
    hideBusy()
    showDialog("Canal indisponível", "Este canal não está disponível agora.", ["OK"], "onLiveFail")
    return
  end if
  fmt = "hls"
  if res.data.kind = "ts" then fmt = "ts"
  startVideo(res.data.url, fmt, [])
end sub

sub onLiveFail()
  closeDialog()
  closePlayer()
end sub

' ---------------------------------------------------------------- vídeo

sub startVideo(url as string, mode as dynamic, captions as dynamic)
  c = CreateObject("roSGNode", "ContentNode")
  c.url = url
  c.title = m.play.title
  fmt = "mp4"
  if mode = "hls" or Instr(1, LCase(url), ".m3u8") > 0 then fmt = "hls"
  if mode = "ts" then fmt = "ts"
  c.streamFormat = fmt
  if m.play.live = false and m.play.resume > 0 then c.PlayStart = m.play.resume

  tracks = []
  if captions <> invalid
    for each cap in captions
      lang = "por"
      if cap.srclang <> invalid and Left(cap.srclang, 2) = "en" then lang = "eng"
      tracks.push({ Language: lang, TrackName: srtUrl(cap.url), Description: cap.label })
    end for
  end if
  c.update({ SubtitleTracks: tracks }, true)

  m.player.content = c
  ' dublado começa sem legenda; original com legenda
  if tracks.count() > 0 and m.play.live = false and m.play.lang <> "dub"
    m.player.globalCaptionMode = "On"
    m.player.subtitleTrack = tracks[0].TrackName
  else
    m.player.globalCaptionMode = "Off"
  end if
  m.player.control = "play"
  m.player.visible = true
  m.player.setFocus(true)
  m.mode = "player"
  m.watchdog = 0
  hideBusy()
end sub

sub onPlayerState()
  st = m.player.state
  if st = "error"
    handleFail()
  else if st = "finished"
    closePlayer()
  end if
end sub

sub handleFail()
  if m.play = invalid then return
  if m.play.live
    closePlayer()
    showDialog("Canal indisponível", "Este canal não está disponível agora.", ["OK"], "onLiveFail")
    return
  end if
  if m.play.autoSwitches < 2
    m.play.autoSwitches = m.play.autoSwitches + 1
    switchVersion()
  else
    m.player.control = "stop"
    showDialog("Não foi possível reproduzir", "Quer tentar outra versão?", ["Outra versão", "Voltar"], "onFailVersion")
  end if
end sub

sub onFailVersion(event as object)
  idx = event.getData()
  closeDialog()
  if idx = 0
    m.play.autoSwitches = 0
    switchVersion()
  else
    closePlayer()
  end if
end sub

' Vídeo errado? Se a duração está muito longe da do filme, troca sozinho para a próxima versão (até 2x).
sub onPlayerDuration()
  if m.play = invalid or m.play.live then return
  if m.play.type <> "movie" or m.play.expectMin <= 0 then return
  dur = m.player.duration
  if dur = invalid or dur < 60 then return
  diff = Abs(dur / 60 - m.play.expectMin)
  limit = 15
  if m.play.expectMin * 0.2 > limit then limit = m.play.expectMin * 0.2
  if diff > limit and m.play.autoSwitches < 2
    m.play.autoSwitches = m.play.autoSwitches + 1
    switchVersion()
  end if
end sub

sub switchVersion()
  if m.play = invalid or m.play.live then return
  if m.play.curSrc <> "" then m.play.skip.push(m.play.curSrc)
  if m.play.curSv <> "" then m.play.skip.push(m.play.curSv)
  where = m.player.position
  if where <> invalid and where > 5 then m.play.resume = Int(where) else m.play.resume = 0
  m.player.control = "stop"
  m.play.curSrc = ""
  m.play.curSv = ""
  showBusy("Carregando outra versão…")
  requestStream()
end sub

sub onVersionMenu(event as object)
  idx = event.getData()
  closeDialog()
  if idx = 0
    m.play.autoSwitches = 0
    switchVersion()
  else if idx = 1
    m.player.control = "resume"
    m.player.setFocus(true)
  else
    closePlayer()
  end if
end sub

sub closePlayer()
  m.player.control = "stop"
  m.player.visible = false
  hideBusy()
  if m.play <> invalid and m.play.live = false and m.detail.visible
    m.mode = "detail"
    m.detail.callFunc("focusMain")
  else
    m.mode = "browse"
    m.rows.setFocus(true)
  end if
  m.play = invalid
end sub

' ---------------------------------------------------------------- caixas de mensagem

sub showBusy(text as string)
  m.busyText.text = text
  m.busyLayer.visible = true
end sub

sub hideBusy()
  m.busyLayer.visible = false
end sub

sub showDialog(title as string, text as string, buttons as object, callback as string)
  hideBusy()
  dlg = CreateObject("roSGNode", "Dialog")
  dlg.title = title
  dlg.message = [text]
  dlg.buttons = buttons
  dlg.observeFieldScoped("buttonSelected", callback)
  m.top.dialog = dlg
end sub

sub closeDialog()
  if m.top.dialog <> invalid then m.top.dialog.close = true
end sub

' ---------------------------------------------------------------- controle remoto

function onKeyEvent(key as string, press as boolean) as boolean
  if not press then return false

  if m.mode = "player"
    if key = "back"
      closePlayer()
      return true
    else if key = "options"
      m.player.control = "pause"
      showDialog("Opções", "O que você quer fazer?", ["Outra versão", "Continuar", "Sair do vídeo"], "onVersionMenu")
      return true
    end if
    return false
  end if

  if m.mode = "browse"
    if key = "down" and m.menu.isInFocusChain() and m.rows.visible
      m.rows.setFocus(true)
      return true
    else if key = "up" and m.rows.isInFocusChain()
      m.menu.setFocus(true)
      return true
    else if key = "back"
      if m.rows.isInFocusChain()
        m.menu.setFocus(true)
        return true
      else if m.tab > 0
        m.menu.focusButton = 0
        loadTab(0)
        return true
      end if
    end if
  end if
  return false
end function
