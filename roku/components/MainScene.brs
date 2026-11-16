' Cena principal: abas, destaque do título em foco, fileiras, detalhe, busca, TV ao vivo e player.
' Regra do dono: o público só vê o vídeo. Nenhuma mensagem aqui cita servidor, fonte ou motivo técnico
' (só com debug=true no config.json, que vem no zip baixado pelo admin).

sub init()
  m.nav = m.top.findNode("nav")
  m.rows = m.top.findNode("rows")
  m.liveRows = m.top.findNode("liveRows")
  m.detail = m.top.findNode("detail")
  m.search = m.top.findNode("search")
  m.player = m.top.findNode("player")
  m.spinner = m.top.findNode("spinner")
  m.empty = m.top.findNode("empty")
  m.busyLayer = m.top.findNode("busyLayer")
  m.busyText = m.top.findNode("busyText")
  m.busySpinner = m.top.findNode("busySpinner")
  m.heroBg = m.top.findNode("heroBg")
  m.heroOverlay = m.top.findNode("heroOverlay")
  m.heroTitle = m.top.findNode("heroTitle")
  m.heroMeta = m.top.findNode("heroMeta")
  m.heroOverview = m.top.findNode("heroOverview")
  m.rowTitle = m.top.findNode("rowTitle")
  m.heroTimer = m.top.findNode("heroTimer")
  m.hint = m.top.findNode("hint")
  m.hintText = m.top.findNode("hintText")
  m.hintTimer = m.top.findNode("hintTimer")
  m.hintText.font = makeFont("pkg:/fonts/Inter-Bold.ttf", 20)
  m.hintTimer.observeField("fire", "hideHint")
  if m.global.debug = true
    info = m.top.findNode("debugInfo")
    info.font = makeFont("pkg:/fonts/Inter-Regular.ttf", 15)
    cfgState = "config ok"
    if m.global.configLoaded <> true then cfgState = "CONFIG NAO LIDO (usando endereco padrao)"
    info.text = "servidor: " + m.global.apiBase + "  ·  " + cfgState
    info.visible = true
  end if

  m.heroTitle.font = makeFont("pkg:/fonts/Inter-Black.ttf", 44)
  m.heroMeta.font = makeFont("pkg:/fonts/Inter-Regular.ttf", 20)
  m.heroOverview.font = makeFont("pkg:/fonts/Inter-Regular.ttf", 22)
  m.rowTitle.font = makeFont("pkg:/fonts/Inter-Bold.ttf", 24)
  m.empty.font = makeFont("pkg:/fonts/Inter-Regular.ttf", 24)
  m.busyText.font = makeFont("pkg:/fonts/Inter-Bold.ttf", 24)

  m.nav.tabs = ["Início", "Filmes", "Séries", "TV ao vivo", "Buscar"]
  m.nav.observeField("activated", "onNav")
  m.rows.observeField("rowItemSelected", "onItemPick")
  m.rows.observeField("rowItemFocused", "onRowFocus")
  m.liveRows.observeField("rowItemSelected", "onItemPick")
  m.liveRows.observeField("rowItemFocused", "onRowFocus")
  m.detail.observeField("playRequest", "onPlayRequest")
  m.detail.observeField("closed", "onDetailClosed")
  m.search.observeField("picked", "onSearchPicked")
  m.search.observeField("closed", "onSearchClosed")
  m.player.observeField("state", "onPlayerState")
  m.player.observeField("duration", "onPlayerDuration")
  m.heroTimer.observeField("fire", "onHeroTimer")

  m.movieRows = { "popular-movies": 1, "top-movies": 1, "now-playing": 1, "g-action": 1, "g-comedy": 1, "g-horror": 1, "g-scifi": 1, "upcoming": 1, "g-animation": 1, "g-romance": 1, "g-thriller": 1, "g-crime": 1, "g-adventure": 1, "g-family": 1, "g-docs": 1 }
  m.tvRows = { "popular-tv": 1, "top-tv": 1, "airing": 1, "tv-drama": 1, "tv-comedy": 1, "tv-anime": 1 }

  m.mode = "browse"        ' browse | detail | search | loading | player
  m.reqSeq = 0
  m.menuOpen = false
  m.tab = 0
  m.loadToken = 0
  m.rowQueue = []
  m.rowNext = 0
  m.rowBusy = false
  m.rowsShown = 0
  m.homeRows = invalid
  m.play = invalid
  m.active = m.rows
  m.pendingBackdrop = ""
  m.langByTitle = {}
  m.nav.setFocus(true)
  loadTab(0)
end sub

' ---------------------------------------------------------------- abas

sub onNav()
  idx = m.nav.activated
  if idx = 4
    openSearch()
  else
    loadTab(idx)
  end if
end sub

sub loadTab(idx as integer)
  m.tab = idx
  m.nav.selected = idx
  m.loadToken = m.loadToken + 1
  m.rowQueue = []
  m.rowNext = 0
  m.rowBusy = false
  m.rowsShown = 0
  m.rowRoot = CreateObject("roSGNode", "ContentNode")
  m.rows.visible = false
  m.liveRows.visible = false
  m.empty.visible = false
  clearHero()
  m.rowTitle.text = ""
  if idx = 3 then m.active = m.liveRows else m.active = m.rows
  m.focusRowsWhenReady = (m.mode = "browse" and not m.nav.isInFocusChain())
  showSpinner(true)

  if idx = 3
    apiGet("/api/live/channels", "onLive", m.loadToken.toStr())
  else if m.homeRows = invalid
    apiGet("/api/home", "onHome", m.loadToken.toStr())
  else
    buildQueue()
  end if
end sub

sub showSpinner(on as boolean)
  m.spinner.visible = on
  if on then m.spinner.control = "start" else m.spinner.control = "stop"
end sub

sub onHome(event as object)
  res = event.getData()
  if res = invalid or res.tag <> m.loadToken.toStr() then return
  if res.ok and res.data <> invalid and res.data.rows <> invalid
    m.homeRows = res.data.rows
    buildQueue()
  else
    showEmpty(failText("Não foi possível carregar agora. Escolha a aba de novo para tentar outra vez.", res))
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
      year = ""
      if it.year <> invalid then year = it.year
      ov = ""
      if it.overview <> invalid then ov = it.overview
      back = ""
      if it.backdrop <> invalid and it.backdrop <> "" then back = posterUrl(it.backdrop, "w780")
      row.appendChild(makeItem(it.type, it.id, it.title, posterUrl(it.poster, "w185"), posterUrl(it.poster, "w342"), back, year, ov, it.rating, genreText(it.genres)))
    end for
    addRow(row)
  else if m.rowsShown = 0 and m.rowNext >= m.rowQueue.count()
    showEmpty(failText("Nada para mostrar agora.", res))
  end if
  ' carrega 3 fileiras logo de cara; as outras vêm conforme a pessoa desce
  if m.rowNext < m.rowQueue.count() and m.rowsShown < 3 then loadNextRow()
end sub

sub addRow(row as object)
  m.rowRoot.appendChild(row)
  m.rowsShown = m.rowsShown + 1
  if m.rowsShown = 1
    m.rows.content = m.rowRoot
    m.rows.visible = true
    showSpinner(false)
    m.empty.visible = false
    m.heroBg.visible = true
    m.heroOverlay.visible = true
    showHero(row.getChild(0), row.title)
    if m.focusRowsWhenReady and m.mode = "browse" then m.rows.setFocus(true)
  end if
end sub

sub showEmpty(text as string)
  showSpinner(false)
  m.rows.visible = false
  m.liveRows.visible = false
  m.empty.text = text
  m.empty.visible = true
end sub

' ---------------------------------------------------------------- destaque (título em foco)

sub clearHero()
  m.heroBg.visible = false
  m.heroBg.uri = ""
  m.heroOverlay.visible = false
  m.heroTitle.text = ""
  m.heroMeta.text = ""
  m.heroOverview.text = ""
  m.pendingBackdrop = ""
end sub

sub showHero(node as object, rowTitleText as string)
  if node = invalid then return
  m.rowTitle.text = rowTitleText
  m.heroTitle.text = node.title
  if m.tab = 3
    m.heroMeta.text = rowTitleText
    m.heroOverview.text = ""
    return
  end if
  rating = invalid
  if node.StarRating > 0 then rating = node.StarRating / 10.0
  m.heroMeta.text = metaLine(node.ReleaseDate, rating, node.ShortDescriptionLine2)
  m.heroOverview.text = node.Description
  m.pendingBackdrop = node.HDBackgroundImageUrl
  m.heroTimer.control = "stop"
  m.heroTimer.control = "start"
end sub

sub onHeroTimer()
  if m.pendingBackdrop <> "" and m.pendingBackdrop <> m.heroBg.uri then m.heroBg.uri = m.pendingBackdrop
end sub

' Carrega mais fileiras conforme a pessoa desce e atualiza o destaque.
sub onRowFocus()
  rl = m.active
  f = rl.rowItemFocused
  if f = invalid or rl.content = invalid then return
  rowNode = rl.content.getChild(f[0])
  if rowNode = invalid then return
  showHero(rowNode.getChild(f[1]), rowNode.title)
  if m.tab < 3 and f[0] >= m.rowsShown - 2 then loadNextRow()
end sub

' ---------------------------------------------------------------- TV ao vivo

sub onLive(event as object)
  res = event.getData()
  if res = invalid or res.tag <> m.loadToken.toStr() then return
  if not res.ok or res.data = invalid or res.data.channels = invalid
    showEmpty(failText("Não foi possível carregar agora. Escolha a aba de novo para tentar outra vez.", res))
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
        bg = ""
        lg = ch.logo
        if lg <> invalid and type(lg) = "roAssociativeArray"
          if lg.u <> invalid then logo = lg.u
          if lg.a <> invalid and lg.a.count() > 0 then bg = lg.a[0]
          if logo <> "" and Left(logo, 4) <> "http" then logo = m.global.apiBase + logo
        end if
        row.appendChild(makeItem("live", ch.id, ch.name, logo, logo, "", "", "", invalid, bg))
      end if
    end for
    if row.getChildCount() > 0 then root.appendChild(row)
  end for
  if root.getChildCount() = 0
    showEmpty("Nenhum canal disponível agora.")
    return
  end if
  m.rowsShown = root.getChildCount()
  m.liveRows.content = root
  m.liveRows.visible = true
  showSpinner(false)
  showHero(root.getChild(0).getChild(0), root.getChild(0).title)
  if m.focusRowsWhenReady and m.mode = "browse" then m.liveRows.setFocus(true)
end sub

' ---------------------------------------------------------------- busca

sub openSearch()
  m.mode = "search"
  m.nav.visible = false
  m.rows.visible = false
  m.liveRows.visible = false
  m.search.visible = true
  m.search.callFunc("reset")
end sub

sub onSearchClosed()
  m.search.visible = false
  m.nav.visible = true
  m.mode = "browse"
  if m.active.visible then m.active.setFocus(true) else m.nav.setFocus(true)
  m.rows.visible = (m.active = m.rows and m.rowsShown > 0)
  m.liveRows.visible = (m.active = m.liveRows and m.rowsShown > 0)
  m.nav.selected = m.tab
end sub

sub onSearchPicked(event as object)
  it = event.getData()
  if it = invalid then return
  m.search.visible = false
  m.mode = "detail"
  m.detail.visible = true
  m.detail.item = it
  m.detail.setFocus(true)
end sub

' ---------------------------------------------------------------- escolher um item

sub onItemPick()
  rl = m.active
  sel = rl.rowItemSelected
  if sel = invalid or rl.content = invalid then return
  node = rl.content.getChild(sel[0]).getChild(sel[1])
  if node = invalid then return
  colon = Instr(1, node.id, ":")
  kind = Left(node.id, colon - 1)
  id = Mid(node.id, colon + 1)
  if kind = "live"
    startLive(id, node.title)
  else
    rating = invalid
    if node.StarRating > 0 then rating = node.StarRating / 10.0
    m.mode = "detail"
    m.nav.visible = false
    m.rows.visible = false
    m.heroBg.visible = false
    m.heroOverlay.visible = false
    m.heroTitle.visible = false
    m.heroMeta.visible = false
    m.heroOverview.visible = false
    m.rowTitle.visible = false
    m.detail.visible = true
    m.detail.item = { type: kind, id: id, title: node.title, year: node.ReleaseDate, overview: node.Description, backdrop: node.HDBackgroundImageUrl, meta: metaLine(node.ReleaseDate, rating, node.ShortDescriptionLine2) }
    m.detail.setFocus(true)
  end if
end sub

sub onDetailClosed()
  m.detail.visible = false
  m.nav.visible = true
  m.rows.visible = (m.active = m.rows)
  m.heroBg.visible = (m.tab < 3)
  m.heroOverlay.visible = (m.tab < 3)
  m.heroTitle.visible = true
  m.heroMeta.visible = true
  m.heroOverview.visible = true
  m.rowTitle.visible = true
  m.mode = "browse"
  if m.active.visible then m.active.setFocus(true) else m.nav.setFocus(true)
end sub

' ---------------------------------------------------------------- tocar (filme / episódio)

sub onPlayRequest(event as object)
  req = event.getData()
  if req = invalid then return
  m.play = { live: false, type: req.type, id: req.id, s: req.s, e: req.e, title: req.title, skip: [], pick: "", lang: "", autoSwitches: 0, resume: 0, expectMin: 0, curSrc: "", curSv: "", tries: 0, token: "", tracks: [], subPref: invalid, subIdx: -1 }
  enterLoading("Carregando…")
  m.play.token = nextToken()
  path = "/api/stream/options?id=" + req.id + "&type=" + req.type + "&s=" + req.s.toStr() + "&e=" + req.e.toStr() + "&hevc=0&title=" + urlEnc(req.title)
  apiGet(path, "onOptions", m.play.token)
end sub

' Enquanto procura o vídeo o foco fica na própria cena: assim o Voltar CANCELA a busca
' (antes o Voltar ia para a tela de detalhe, que fechava por baixo e o vídeo abria depois por cima da lista).
sub enterLoading(text as string)
  m.mode = "loading"
  m.top.setFocus(true)
  showBusy(text)
end sub

function nextToken() as string
  m.reqSeq = m.reqSeq + 1
  return "r" + m.reqSeq.toStr()
end function

sub onOptions(event as object)
  if m.play = invalid then return
  res = event.getData()
  if res <> invalid and res.tag <> m.play.token then return
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
  requestStream()
end sub

sub requestStream()
  enterLoading("Carregando…")
  p = m.play
  path = "/api/stream?id=" + p.id + "&type=" + p.type + "&hevc=0&title=" + urlEnc(p.title)
  if p.type = "tv" then path = path + "&s=" + p.s.toStr() + "&e=" + p.e.toStr()
  if p.pick <> "" then path = path + "&pick=" + p.pick
  if p.skip.count() > 0 then path = path + "&fresh=1&skip=" + joinList(p.skip, ",")
  m.play.token = nextToken()
  apiGet(path, "onStream", m.play.token)
end sub

sub onStream(event as object)
  if m.play = invalid then return
  res = event.getData()
  if res <> invalid and res.tag <> m.play.token then return
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
  m.play = { live: true, ch: id, title: title, skip: [], tries: 0, token: "", tracks: [], subPref: invalid, subIdx: -1 }
  enterLoading("Carregando…")
  requestLive()
end sub

sub requestLive()
  path = "/api/live/stream?ch=" + urlEnc(m.play.ch)
  if m.play.skip.count() > 0 then path = path + "&skip=" + joinList(m.play.skip, ",")
  m.play.token = nextToken()
  apiGet(path, "onLiveStream", m.play.token)
end sub

sub onLiveStream(event as object)
  if m.play = invalid or not m.play.live then return
  res = event.getData()
  if res <> invalid and res.tag <> m.play.token then return
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

  m.play.tracks = sortTracks(captions)
  content = []
  for each t in m.play.tracks
    content.push({ Language: t.Language, TrackName: t.TrackName, Description: t.Description })
  end for
  c.update({ SubtitleTracks: content }, true)

  m.player.content = c
  ' Legenda: o que a pessoa escolheu vale; senão dublado começa sem legenda e original liga (português primeiro).
  want = -1
  pref = m.play.subPref
  if m.play.live = false and m.play.tracks.count() > 0
    if pref = invalid
      if m.play.lang <> "dub" then want = 0
    else if type(pref) = "roAssociativeArray"
      for i = 0 to m.play.tracks.count() - 1
        t = m.play.tracks[i]
        if t.srclang = pref.srclang and t.translated = pref.translated and want < 0 then want = i
      end for
      if want < 0 and m.play.lang <> "dub" then want = 0
    end if
  end if
  applySub(want)
  m.player.control = "play"
  m.player.visible = true
  m.player.setFocus(true)
  m.mode = "player"
  m.watchdog = 0
  hideBusy()
  showHint()
end sub

' ---------------------------------------------------------------- dica e menu do player

sub showHint()
  if m.play.live
    m.hintText.text = "  Seta para baixo ou *: opções"
  else
    m.hintText.text = "  Seta para baixo ou *: legenda e outra versão"
  end if
  m.hint.visible = true
  m.hintTimer.control = "stop"
  m.hintTimer.control = "start"
end sub

sub hideHint()
  m.hint.visible = false
  m.hintTimer.control = "stop"
end sub

' idx = -1 desliga a legenda; senão liga a faixa idx da lista ordenada.
sub applySub(idx as integer)
  if m.play = invalid then return
  if idx < 0 or idx >= m.play.tracks.count()
    m.play.subIdx = -1
    m.player.globalCaptionMode = "Off"
  else
    m.play.subIdx = idx
    m.player.globalCaptionMode = "On"
    m.player.subtitleTrack = m.play.tracks[idx].TrackName
  end if
end sub

sub openMenu()
  hideHint()
  m.player.control = "pause"
  m.menuOpen = true
  m.menuIds = []
  labels = []
  if m.play.live = false
    if m.play.tracks.count() > 0
      m.menuIds.push("sub")
      labels.push("Legenda")
    end if
    m.menuIds.push("ver")
    labels.push("Outra versão")
  end if
  m.menuIds.push("home")
  labels.push("Ir para o início")
  m.menuIds.push("go")
  labels.push("Continuar")
  showDialog("Opções", "O que você quer fazer?", labels, "onMenu")
end sub

sub onMenu(event as object)
  idx = event.getData()
  what = m.menuIds[idx]
  if what = "sub"
    openSubMenu()
    return
  end if
  m.menuOpen = false
  closeDialog()
  if what = "ver"
    m.play.autoSwitches = 0
    switchVersion()
  else if what = "home"
    goHome()
  else
    resumePlayer()
  end if
end sub

sub openSubMenu()
  m.subMap = []
  labels = ["Sem legenda"]
  if m.play.subIdx < 0 then labels[0] = "Sem legenda  (ativa)"
  for i = 0 to m.play.tracks.count() - 1
    t = m.play.tracks[i]
    if labels.count() < 7 and (t.score < 100 or isLatinLabel(t.Description))
      name = t.Description
      if i = m.play.subIdx then name = name + "  (ativa)"
      labels.push(name)
      m.subMap.push(i)
    end if
  end for
  closeDialog()
  showDialog("Legenda", "Escolha a legenda.", labels, "onSubMenu")
end sub

sub onSubMenu(event as object)
  idx = event.getData()
  m.menuOpen = false
  closeDialog()
  if idx = 0
    m.play.subPref = "off"
    applySub(-1)
  else
    i = m.subMap[idx - 1]
    t = m.play.tracks[i]
    m.play.subPref = { srclang: t.srclang, translated: t.translated }
    applySub(i)
  end if
  resumePlayer()
end sub

' Voltar dentro de uma caixa de opções fecha a caixa sem escolher nada: o vídeo continua de onde parou.
sub onDialogClosed()
  if m.top.dialog <> invalid then return
  if m.menuOpen
    m.menuOpen = false
    resumePlayer()
  end if
end sub

sub resumePlayer()
  if m.mode = "player"
    m.player.control = "resume"
    m.player.setFocus(true)
  end if
end sub

' Volta direto para o início (aba Início, foco na barra de abas), de qualquer ponto do vídeo.
sub goHome()
  m.menuOpen = false
  m.player.control = "stop"
  m.player.visible = false
  hideBusy()
  hideHint()
  m.play = invalid
  m.search.visible = false
  onDetailClosed()
  m.nav.setFocus(true)
  loadTab(0)
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
  requestStream()
end sub

sub closePlayer()
  m.menuOpen = false
  m.player.control = "stop"
  m.player.visible = false
  hideBusy()
  hideHint()
  if m.play <> invalid and m.play.live = false and m.detail.visible
    m.mode = "detail"
    m.detail.callFunc("focusMain")
  else
    m.mode = "browse"
    if m.active.visible then m.active.setFocus(true) else m.nav.setFocus(true)
  end if
  m.play = invalid
end sub

' ---------------------------------------------------------------- caixas de mensagem

sub showBusy(text as string)
  m.busyText.text = text
  m.busyLayer.visible = true
  m.busySpinner.control = "start"
end sub

sub hideBusy()
  m.busyLayer.visible = false
  m.busySpinner.control = "stop"
end sub

sub showDialog(title as string, text as string, buttons as object, callback as string)
  hideBusy()
  dlg = CreateObject("roSGNode", "Dialog")
  dlg.title = title
  dlg.message = text
  dlg.buttons = buttons
  dlg.observeFieldScoped("buttonSelected", callback)
  dlg.observeFieldScoped("wasClosed", "onDialogClosed")
  m.top.dialog = dlg
end sub

sub closeDialog()
  if m.top.dialog <> invalid then m.top.dialog.close = true
end sub

' ---------------------------------------------------------------- controle remoto

function onKeyEvent(key as string, press as boolean) as boolean
  if not press then return false

  if m.mode = "loading"
    ' Voltar durante o "Carregando…" cancela e volta para onde estava (resposta atrasada é ignorada pelo token)
    if key = "back"
      closePlayer()
      return true
    end if
    return true
  end if

  if m.mode = "player"
    if key = "back"
      closePlayer()
      return true
    else if key = "options" or key = "down"
      ' "*" não existe no controle Voltar/Lite: a seta para baixo abre o mesmo menu
      openMenu()
      return true
    end if
    return false
  end if

  if m.mode = "browse"
    if key = "down" and m.nav.isInFocusChain() and m.active.visible
      m.active.setFocus(true)
      return true
    else if key = "up" and m.active.isInFocusChain()
      m.nav.setFocus(true)
      return true
    else if key = "back"
      if m.active.isInFocusChain()
        m.nav.setFocus(true)
        return true
      else if m.tab > 0
        loadTab(0)
        return true
      end if
    end if
  end if
  return false
end function
