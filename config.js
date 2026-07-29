export const config = {
  mainCommunity: 'brunnerschaft',
  generated: new Date().toISOString().slice(0,10),
  // Nicht auto-erkennbare Saisons (aktive/laufende + separate Community) hier deklarieren:
  seasons: [
    { id:'5422358', name:'Bundesliga 2026/27', short:'BL 26/27', type:'BL', community:'brunnerschaft' },
    { id:'2540119', name:'Europameisterschaft 2024', short:'EM 2024', type:'EM', community:'brunnerschaft-em2024' },
  ],
  displayOrder: ['5422358','4634406','3837133','2540119','3218962','1843545','1009489','1195969','700552'],
};
