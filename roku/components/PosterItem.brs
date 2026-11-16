sub onContent()
  c = m.top.itemContent
  if c = invalid then return
  m.top.findNode("poster").uri = c.HDPosterUrl
end sub

sub onSize()
  w = m.top.width
  h = m.top.height
  if w <= 0 or h <= 0 then return
  m.top.findNode("ph").width = w
  m.top.findNode("ph").height = h
  m.top.findNode("poster").width = w
  m.top.findNode("poster").height = h
end sub
