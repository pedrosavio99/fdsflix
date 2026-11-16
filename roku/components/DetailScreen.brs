sub init()
  m.title = m.top.findNode("title")
  m.meta = m.top.findNode("meta")
  m.overview = m.top.findNode("overview")
  m.backdrop = m.top.findNode("backdrop")
  m.playBtn = m.top.findNode("playBtn")
  m.homeBtn = m.top.findNode("homeBtn")
  m.seasons = m.top.findNode("seasons")
  m.eps = m.top.findNode("eps")
  m.spinner = m.top.findNode("spinner")
  m.note = m.top.findNode("note")
  m.panel = m.top.findNode("panel")
  m.title.font = makeFont("pkg:/fonts/Inter-Black.ttf", 46)
  m.meta.font = makeFont("pkg:/fonts/Inter-Regular.ttf", 20)
  m.overview.font = makeFont("pkg:/fonts/Inter-Regular.ttf", 22)
  m.note.font = makeFont("pkg:/fonts/Inter-Regular.ttf", 20)
  m.cur = invalid
  m.curSeason = 0
  m.focusOn = "play"
  m.playBtn.observeField("selected", "onPlayMovie")
  m.homeBtn.observeField("selected", "onHomeBtn")
  m.seasons.observeField("itemFocused", "onSeasonFocus")
  m.seasons.observeField("itemSelected", "onSeasonSelected")
  m.eps.observeField("itemSelected", "onEpisodePick")
end sub

sub onItem()
  it = m.top.item
  if it = invalid then return
  m.cur = it
  m.title.text = it.title
  m.meta.text = it.meta
  m.overview.text = it.overview
  m.backdrop.uri = it.backdrop
  m.playBtn.visible = false
  placeHome(it.type)
  m.panel.visible = false
  m.seasons.visible = false
  m.eps.visible = false
  m.note.visible = false
  m.spinner.visible = true
  m.spinner.control = "start"
  m.curSeason = 0
  apiGet("/api/details?id=" + it.id + "&type=" + it.type, "onDetails")
end sub

sub onDetails(event as object)
  res = event.getData()
  m.spinner.control = "stop"
  m.spinner.visible = false
  d = invalid
  if res <> invalid and res.ok then d = res.data
  if d <> invalid
    if d.title <> invalid and d.title <> "" then m.title.text = d.title
    parts = []
    if d.year <> invalid and d.year <> "" then parts.push(d.year)
    if d.certification <> invalid and d.certification <> "" then parts.push(d.certification)
    if d.runtime <> invalid and d.runtime > 0 then parts.push(d.runtime.toStr() + " min")
    if d.rating <> invalid and d.rating > 0 then parts.push("★ " + Str(d.rating).trim())
    if d.genres <> invalid and d.genres.count() > 0 then parts.push(joinList(d.genres, ", "))
    m.meta.text = joinList(parts, "   ·   ")
    if d.overview <> invalid and d.overview <> "" then m.overview.text = d.overview
    if d.backdrop <> invalid and d.backdrop <> "" then m.backdrop.uri = posterUrl(d.backdrop, "w1280")
  end if

  if m.cur.type = "movie"
    m.playBtn.visible = true
    m.playBtn.setFocus(true)
    m.focusOn = "play"
    if d = invalid and m.global.debug = true
      m.note.text = failText("Detalhes indisponíveis.", res)
      m.note.visible = true
    end if
    return
  end if

  ' série: temporadas à esquerda, episódios à direita
  seasonList = []
  if d <> invalid and d.seasons <> invalid then seasonList = d.seasons
  if seasonList.count() = 0 then seasonList = [{ n: 1 }]
  root = CreateObject("roSGNode", "ContentNode")
  for each s in seasonList
    node = root.createChild("ContentNode")
    node.id = s.n.toStr()
    node.title = "Temporada " + s.n.toStr()
  end for
  ' último item da lista: "Menu inicial" (Cima a partir da Temporada 1 dá a volta até ele)
  homeItem = root.createChild("ContentNode")
  homeItem.id = "home"
  homeItem.title = "Menu inicial"
  m.seasons.content = root
  m.panel.visible = true
  m.seasons.visible = true
  m.eps.visible = true
  m.seasons.setFocus(true)
  m.focusOn = "seasons"
  onSeasonFocus()
end sub

sub onSeasonFocus()
  if m.seasons.content = invalid then return
  idx = m.seasons.itemFocused
  if idx < 0 or idx >= m.seasons.content.getChildCount() then return
  sid = m.seasons.content.getChild(idx).id
  if sid = "home" then return
  n = sid.toInt()
  if n = m.curSeason then return
  m.curSeason = n
  m.eps.content = invalid
  apiGet("/api/season?id=" + m.cur.id + "&n=" + n.toStr(), "onSeason", n.toStr())
end sub

sub onSeason(event as object)
  res = event.getData()
  if res = invalid or res.tag <> m.curSeason.toStr() then return
  root = CreateObject("roSGNode", "ContentNode")
  if res.ok and res.data <> invalid and res.data.episodes <> invalid
    for each ep in res.data.episodes
      node = root.createChild("ContentNode")
      node.id = ep.e.toStr()
      node.title = ep.e.toStr() + ".  " + ep.name
      runtime = ""
      if ep.runtime <> invalid and ep.runtime > 0 then runtime = ep.runtime.toStr() + " min"
      node.ShortDescriptionLine2 = runtime
      ov = ""
      if ep.overview <> invalid then ov = ep.overview
      node.Description = ov
      node.HDPosterUrl = posterUrl(ep.still, "w300")
    end for
  else
    m.note.text = failText("Não foi possível carregar os episódios.", res)
    m.note.visible = true
  end if
  m.eps.content = root
end sub

' Seleção na lista de temporadas: o 1º item é o "Menu inicial".
sub onSeasonSelected()
  idx = m.seasons.itemSelected
  if idx >= 0 and m.seasons.content <> invalid and m.seasons.content.getChild(idx).id = "home"
    m.top.goHome = true
    return
  end if
  onSeasonPick()
end sub

function seasonIsHome() as boolean
  if m.seasons.content = invalid then return false
  idx = m.seasons.itemFocused
  if idx < 0 or idx >= m.seasons.content.getChildCount() then return false
  return m.seasons.content.getChild(idx).id = "home"
end function

sub onSeasonPick()
  if m.eps.content <> invalid and m.eps.content.getChildCount() > 0
    m.eps.setFocus(true)
    m.focusOn = "eps"
  end if
end sub

' Filme: botão ao lado do "Assistir". Série: "Menu inicial" é o ÚLTIMO item da lista de temporadas
' (uma lista dá a volta com a seta para cima, então um botão fora dela não seria alcançado). Fica por ÚLTIMO..
sub placeHome(kind as string)
  m.homeBtn.translation = [352, 372]
  m.homeBtn.width = 240
  m.homeBtn.visible = (kind = "movie")
end sub

sub onHomeBtn()
  m.top.goHome = true
end sub

sub onPlayMovie()
  m.top.playRequest = { type: "movie", id: m.cur.id, s: 1, e: 1, title: m.title.text }
end sub

sub onEpisodePick()
  idx = m.eps.itemSelected
  if idx < 0 or m.eps.content = invalid then return
  e = m.eps.content.getChild(idx).id.toInt()
  m.top.playRequest = { type: "tv", id: m.cur.id, s: m.curSeason, e: e, title: m.title.text + "  T" + m.curSeason.toStr() + "E" + e.toStr() }
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if not press then return false
  if key = "back"
    m.top.closed = true
    return true
  else if key = "right" and m.focusOn = "play"
    m.homeBtn.setFocus(true)
    m.focusOn = "home"
    return true
  else if key = "left" and m.focusOn = "home" and m.cur <> invalid and m.cur.type = "movie"
    m.playBtn.setFocus(true)
    m.focusOn = "play"
    return true
  else if key = "right" and m.focusOn = "seasons"
    if not seasonIsHome() then onSeasonPick()
    return true
  else if key = "left" and m.focusOn = "eps"
    m.seasons.setFocus(true)
    m.focusOn = "seasons"
    return true
  end if
  return false
end function

' Chamado pela cena para devolver o foco depois do vídeo.
sub focusMain()
  if m.cur = invalid then return
  if m.focusOn = "home"
    m.homeBtn.setFocus(true)
  else if m.cur.type = "movie"
    m.playBtn.setFocus(true)
    m.focusOn = "play"
  else if m.focusOn = "eps"
    m.eps.setFocus(true)
  else
    m.seasons.setFocus(true)
  end if
end sub
