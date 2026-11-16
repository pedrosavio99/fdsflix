sub init()
  m.top.findNode("title").font = makeFont("pkg:/fonts/Inter-Bold.ttf", 21)
  m.top.findNode("info").font = makeFont("pkg:/fonts/Inter-Regular.ttf", 17)
end sub

sub onContent()
  c = m.top.itemContent
  if c = invalid then return
  m.top.findNode("thumb").uri = c.HDPosterUrl
  m.top.findNode("title").text = c.title
  info = c.ShortDescriptionLine2
  if c.Description <> "" then info = info + "  " + c.Description
  m.top.findNode("info").text = info
end sub
