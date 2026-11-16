sub init()
  m.title = m.top.findNode("title")
  m.meta = m.top.findNode("meta")
  m.overview = m.top.findNode("overview")
  m.poster = m.top.findNode("poster")
  m.backdrop = m.top.findNode("backdrop")
  m.actions = m.top.findNode("actions")
  m.seasons = m.top.findNode("seasons")
  m.eps = m.top.findNode("eps")
  m.busy = m.top.findNode("busy")
  m.cur = invalid
  m.curSeason = 0
  m.focusOn = "actions"
  m.actions.observeField("buttonSelected", "onPlayMovie")
  m.seasons.observeField("itemFocused", "onSeasonFocus")
  m.seasons.observeField("itemSelected", "onSeasonPick")
  m.eps.observeField("itemSelected", "onEpisodePick")
end sub

sub onItem()
  it = m.top.item
  if it = invalid then return
  m.cur = it
  m.title.text = it.title
  m.meta.text = it.year
  m.overview.text = it.overview
  m.poster.uri = it.poster
  m.backdrop.uri = ""
  m.actions.visible = false
  m.seasons.visible = false
  m.eps.visible = false
  m.busy.visible = true
  m.curSeason = 0
  apiGet("/api/details?id=" + it.id + "&type=" + it.type, "onDetails")
end sub

sub onDetails(event as object)
  res = event.getData()
  m.busy.visible = false
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
    m.meta.text = joinList(parts, "  ·  ")
    if d.overview <> invalid and d.overview <> "" then m.overview.text = d.overview
    if d.backdrop <> invalid and d.backdrop <> "" then m.backdrop.uri = posterUrl(d.backdrop, "w780")
  end if

  if m.cur.type = "movie"
    m.actions.visible = true
    m.actions.setFocus(true)
    m.focusOn = "actions"
    return
  end if

  ' série: temporadas à esquerda, episódios à direita
  seasonList = []
  if d <> invalid and d.seasons <> invalid then seasonList = d.seasons
  if seasonList.count() = 0 then seasonList = [{ n: 1, name: "Temporada 1" }]
  root = CreateObject("roSGNode", "ContentNode")
  for each s in seasonList
    node = root.createChild("ContentNode")
    node.id = s.n.toStr()
    nm = "Temporada " + s.n.toStr()
    node.title = nm
  end for
  m.seasons.content = root
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
  n = m.seasons.content.getChild(idx).id.toInt()
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
      label = ep.e.toStr() + ".  " + ep.name
      if ep.runtime <> invalid and ep.runtime > 0 then label = label + "  (" + ep.runtime.toStr() + " min)"
      node.title = label
    end for
  end if
  m.eps.content = root
end sub

sub onSeasonPick()
  if m.eps.content <> invalid and m.eps.content.getChildCount() > 0
    m.eps.setFocus(true)
    m.focusOn = "eps"
  end if
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
  else if key = "right" and m.focusOn = "seasons"
    onSeasonPick()
    return true
  else if key = "left" and m.focusOn = "eps"
    m.seasons.setFocus(true)
    m.focusOn = "seasons"
    return true
  end if
  return false
end function

' Chamado pela cena para devolver o foco ao abrir de novo.
sub focusMain()
  if m.cur = invalid then return
  if m.cur.type = "movie" then m.actions.setFocus(true) else m.seasons.setFocus(true)
end sub
