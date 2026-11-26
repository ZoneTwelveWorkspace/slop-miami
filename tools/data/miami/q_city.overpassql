[out:json][timeout:600];
(
  way["highway"](25.7550,-80.2050,25.7930,-80.1780);
  way["natural"="coastline"](25.7400,-80.2200,25.8100,-80.1500);
  way["natural"="water"](25.7550,-80.2050,25.7930,-80.1780);
  relation["natural"="water"](25.7550,-80.2050,25.7930,-80.1780);
  way["waterway"="riverbank"](25.7550,-80.2050,25.7930,-80.1780);
  way["leisure"~"^(park|garden|pitch|playground|dog_park|marina)$"](25.7550,-80.2050,25.7930,-80.1780);
  relation["leisure"="park"](25.7550,-80.2050,25.7930,-80.1780);
  way["landuse"~"^(grass|recreation_ground|village_green)$"](25.7550,-80.2050,25.7930,-80.1780);
  way["railway"~"^(light_rail|monorail|subway|rail)$"](25.7550,-80.2050,25.7930,-80.1780);
  node["highway"="traffic_signals"](25.7550,-80.2050,25.7930,-80.1780);
  way["man_made"~"^(pier|breakwater|groyne)$"](25.7550,-80.2050,25.7930,-80.1780);
  way["building"]["name"](25.7550,-80.2050,25.7930,-80.1780);
  relation["building"]["name"](25.7550,-80.2050,25.7930,-80.1780);
  nwr["tourism"~"^(attraction|museum|viewpoint)$"](25.7550,-80.2050,25.7930,-80.1780);
);
out geom;
