# Office floors: types, layouts, sizes

The suites behind the doors on office and loft floors (src/rooms/vertical.ts halls) open onto
`OfficeLevel` (src/rooms/office.ts). Each suite has a type, picked by building, floor, unit and
district (`officeTypeFor`), so revisiting a suite always shows the same type. Within one unit
column, two adjacent floors never repeat a type.

## References

- Open-plan layout guides with aisle and desk sizes:
  [OF2go 25-person plan](https://www.officefurniture2go.com/plan/pdfs/OF2go_Open_Office_Layout_for_25_Employees_Space_Plan.pdf),
  [aisle width between desks](https://www.officefurniture2go.com/answers/desk-space-planning/standard-aisle-width-between-desks.html),
  [rayon.design open space dimensions](https://rayon.design/knowledge-base/open-space-office/dimensions).
- Benching sizes: [Arcedior workstation sizes](https://arcedior.com/blog/workstation-sizes-india-guideline).
- Phone booths: [Autonomous booth dimensions](https://www.autonomous.ai/ourblog/some-important-office-booth-dimensions),
  [Branch phone booth](https://www.branchfurniture.com/products/phone-booth) (1080 x 1000 x 2300 mm).
- Cubicles: [cubicle sizes](https://officeconsumer.com/what-is-the-optimal-office-cubicle-size-w-examples-faqs/).
- Law firm offices: perimeter private offices, staff in the core
  ([Stantec](https://stantec.com/en/ideas/shrinking-space-post-pandemic-law-firm-offices-are-smaller-more-communal),
  [Savills](https://www.savills.us/blog/article/395753-0/us-articles/what-sets-law-firm-build-outs-apart-from-traditional-commercial-offices.aspx));
  interior associate offices 150-200 sq ft, partner offices 250-350 sq ft.
- 1980s offices: system partitions, acoustic drop ceilings, sound masking
  ([Facilitiesnet retrospective](https://www.facilitiesnet.com/facilitiesmanagement/article.aspx?id=20200),
  [Architect: prefab partitions](https://www.architectmagazine.com/technology/products/the-evolution-of-office-design-and-pre-fab-partitions-of-the-20th-century_o)).

## Numbers used

| Thing | Size |
|---|---|
| Desk | 1.2-1.6 m wide, 0.7-0.8 m deep, top 0.74 m |
| Benching seat | 1.4-1.6 m per seat, double-sided, 0.75 m deep each side |
| Cubicle | 2.2 m (corporate) / 2.4 m (1980s) square, panels 1.4 / 1.6 m tall |
| Private office | about 3.2 x 3.6 m (associate, ~125 sq ft) along the window wall |
| Phone booth | 1.1 x 1.0 x 2.3 m |
| Primary aisle | 1.5 m (spine from the entry); secondary aisles at least 1.1 m (qa: at least 0.9 m clear) |
| Drop ceiling | 0.6 m grid, about 2.6 m clear (1980s); troffers 0.6 x 1.2 m |
| Meeting room | glass walls, about 4.5 x 4 m, whiteboard, 6-8 seats |

## Types

| Type | Layout | Materials |
|---|---|---|
| tech | double-sided benching columns, phone booths, glass meeting room | polished concrete, open ceiling with ducts and pendants |
| cubicle | back-to-back cubicles, 1.4 m panels | grey carpet tile, drop ceiling with troffers |
| law | private window offices along the back wall, admin pool in the core | warm carpet, walnut panelling |
| creative | long communal tables, pinboard wall | exposed brick, plank floor, ducts |
| eighties | beige 1.6 m partitions, wood-grain desks, CRT monitors | brown carpet tile, low drop ceiling |
| dentist | waiting room, treatment rooms with dental chairs | pale vinyl, white walls |
| gym | treadmill row at the windows, weight racks, mirror wall | rubber floor, dark walls |
| cowork | hot-desk benches, lounge sofas, booths, coffee bar | parquet |
