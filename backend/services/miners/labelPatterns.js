/**
 * Multi-Language Label Patterns
 * Supports 10+ languages for field detection
 */

// Field labels in multiple languages
const FIELD_LABELS = {
    company: [
        // English
        'company', 'organization', 'organisation', 'firm', 'business', 'corp', 'corporation',
        // Turkish
        'firma', 'şirket', 'kuruluş', 'işletme', 'kurumsal',
        // French
        'société', 'entreprise', 'compagnie', 'établissement',
        // German
        'firma', 'unternehmen', 'betrieb', 'gesellschaft',
        // Spanish
        'empresa', 'compañía', 'organización', 'corporación',
        // Italian
        'azienda', 'società', 'impresa', 'ditta',
        // Dutch
        'bedrijf', 'onderneming', 'firma',
        // Portuguese
        'empresa', 'companhia', 'organização',
        // Arabic
        'شركة', 'مؤسسة', 'منظمة',
        // Russian
        'компания', 'организация', 'фирма', 'предприятие',
        // Chinese
        '公司', '企业', '组织', '机构',
        // Japanese
        '会社', '企業', '組織',
        // Korean
        '회사', '기업', '조직',
    ],
    
    name: [
        // English
        'name', 'contact', 'person', 'representative', 'contact person', 'contact name',
        'full name', 'fullname',
        // Turkish
        'isim', 'ad', 'kişi', 'yetkili', 'temsilci', 'ad soyad', 'adsoyad',
        // French
        'nom', 'prénom', 'contact', 'personne', 'représentant', 'nom complet',
        // German
        'name', 'ansprechpartner', 'kontakt', 'kontaktperson', 'vollständiger name',
        // Spanish
        'nombre', 'contacto', 'persona', 'representante', 'nombre completo',
        // Italian
        'nome', 'contatto', 'persona', 'referente', 'nome completo',
        // Dutch
        'naam', 'contact', 'contactpersoon', 'volledige naam',
        // Portuguese
        'nome', 'contato', 'pessoa', 'representante',
        // Arabic
        'اسم', 'جهة الاتصال', 'شخص', 'ممثل', 'الاسم الكامل',
        // Russian
        'имя', 'контакт', 'контактное лицо', 'представитель', 'полное имя',
        // Chinese
        '姓名', '联系人', '联络人', '代表',
        // Japanese
        '名前', '氏名', '担当者', '連絡先',
        // Korean
        '이름', '담당자', '연락처', '대표자',
    ],
    
    email: [
        // Universal
        'email', 'e-mail', 'mail', 'email address', 'e-mail address',
        // Turkish
        'e-posta', 'eposta', 'posta',
        // French
        'courriel', 'adresse email', 'adresse e-mail', 'mél',
        // German
        'e-mail', 'email-adresse', 'mailadresse',
        // Spanish
        'correo', 'correo electrónico', 'email',
        // Italian
        'email', 'posta elettronica', 'indirizzo email',
        // Dutch
        'e-mail', 'emailadres',
        // Portuguese
        'e-mail', 'correio eletrônico',
        // Arabic
        'البريد الإلكتروني', 'إيميل', 'بريد',
        // Russian
        'электронная почта', 'email', 'почта', 'имейл',
        // Chinese
        '电子邮件', '邮箱', '电邮',
        // Japanese
        'メール', 'メールアドレス', 'Eメール',
        // Korean
        '이메일', '메일', '전자메일',
    ],
    
    phone: [
        // English
        'phone', 'telephone', 'tel', 'mobile', 'cell', 'cellphone', 'phone number',
        'contact number', 'fax',
        // Turkish
        'telefon', 'tel', 'gsm', 'cep', 'cep telefonu', 'mobil', 'faks',
        // French
        'téléphone', 'tél', 'portable', 'mobile', 'numéro', 'fax',
        // German
        'telefon', 'tel', 'handy', 'mobiltelefon', 'rufnummer', 'fax',
        // Spanish
        'teléfono', 'tel', 'móvil', 'celular', 'número', 'fax',
        // Italian
        'telefono', 'tel', 'cellulare', 'mobile', 'numero', 'fax',
        // Dutch
        'telefoon', 'tel', 'mobiel', 'gsm', 'fax',
        // Portuguese
        'telefone', 'tel', 'celular', 'telemóvel', 'fax',
        // Arabic
        'هاتف', 'تلفون', 'جوال', 'موبايل', 'رقم', 'فاكس',
        // Russian
        'телефон', 'тел', 'мобильный', 'сотовый', 'факс',
        // Chinese
        '电话', '手机', '移动电话', '联系电话', '传真',
        // Japanese
        '電話', '携帯', '携帯電話', 'ファックス',
        // Korean
        '전화', '휴대폰', '핸드폰', '연락처', '팩스',
    ],
    
    country: [
        // English
        'country', 'nation', 'country/region',
        // Turkish
        'ülke', 'memleket',
        // French
        'pays', 'nation',
        // German
        'land', 'staat',
        // Spanish
        'país', 'nación',
        // Italian
        'paese', 'nazione',
        // Dutch
        'land',
        // Portuguese
        'país', 'nação',
        // Arabic
        'بلد', 'دولة', 'الدولة',
        // Russian
        'страна', 'государство',
        // Chinese
        '国家', '国', '地区',
        // Japanese
        '国', '国名',
        // Korean
        '국가', '나라',
    ],
    
    city: [
        // English
        'city', 'town', 'location',
        // Turkish
        'şehir', 'il', 'ilçe', 'bölge', 'lokasyon',
        // French
        'ville', 'cité', 'localité',
        // German
        'stadt', 'ort', 'standort',
        // Spanish
        'ciudad', 'localidad', 'ubicación',
        // Italian
        'città', 'località', 'luogo',
        // Dutch
        'stad', 'plaats', 'locatie',
        // Portuguese
        'cidade', 'localidade', 'local',
        // Arabic
        'مدينة', 'موقع',
        // Russian
        'город', 'населённый пункт', 'местоположение',
        // Chinese
        '城市', '市', '地点',
        // Japanese
        '市', '都市', '所在地',
        // Korean
        '도시', '시', '위치',
    ],
    
    address: [
        // English
        'address', 'street', 'location', 'postal address',
        // Turkish
        'adres', 'adress', 'sokak', 'cadde',
        // French
        'adresse', 'rue', 'adresse postale',
        // German
        'adresse', 'anschrift', 'straße',
        // Spanish
        'dirección', 'calle', 'domicilio',
        // Italian
        'indirizzo', 'via', 'sede',
        // Dutch
        'adres', 'straat',
        // Portuguese
        'endereço', 'morada', 'rua',
        // Arabic
        'عنوان', 'شارع',
        // Russian
        'адрес', 'улица',
        // Chinese
        '地址', '街道',
        // Japanese
        '住所', '所在地',
        // Korean
        '주소', '거리',
    ],
    
    website: [
        // Universal
        'website', 'web', 'url', 'site', 'homepage', 'web address', 'www',
        // Turkish
        'web sitesi', 'web site', 'internet sitesi',
        // French
        'site web', 'site internet', 'page web',
        // German
        'webseite', 'internetseite', 'homepage',
        // Spanish
        'sitio web', 'página web',
        // Italian
        'sito web', 'sito internet',
        // Dutch
        'website', 'webpagina',
        // Portuguese
        'site', 'página web',
        // Arabic
        'موقع', 'موقع الويب', 'الموقع الإلكتروني',
        // Russian
        'сайт', 'веб-сайт', 'интернет-сайт',
        // Chinese
        '网站', '网址', '官网',
        // Japanese
        'ウェブサイト', 'ホームページ',
        // Korean
        '웹사이트', '홈페이지',
    ],
    
    title: [
        // English
        'title', 'position', 'role', 'job title', 'designation', 'occupation',
        // Turkish
        'ünvan', 'pozisyon', 'görev', 'iş unvanı', 'meslek',
        // French
        'titre', 'poste', 'fonction', 'rôle',
        // German
        'titel', 'position', 'funktion', 'stelle', 'beruf',
        // Spanish
        'título', 'cargo', 'puesto', 'posición',
        // Italian
        'titolo', 'posizione', 'ruolo', 'mansione',
        // Dutch
        'titel', 'functie', 'positie',
        // Portuguese
        'título', 'cargo', 'função', 'posição',
        // Arabic
        'المسمى الوظيفي', 'وظيفة', 'منصب',
        // Russian
        'должность', 'позиция', 'звание',
        // Chinese
        '职位', '头衔', '职务',
        // Japanese
        '役職', '職位', '肩書き',
        // Korean
        '직함', '직위', '역할',
    ],
};

/**
 * Build regex patterns for each field
 * Creates patterns that match "Label:" or "Label :" at start of line
 */
function buildLabelPatterns() {
    const patterns = {};
    
    for (const [field, labels] of Object.entries(FIELD_LABELS)) {
        // Escape special regex characters and join with |
        const escaped = labels.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        
        // Pattern: Start of line (or after newline), optional whitespace, label, optional whitespace, colon
        const regexStr = `(?:^|\\n)\\s*(${escaped.join('|')})\\s*[:\\-]\\s*`;
        
        patterns[field] = new RegExp(regexStr, 'gim');
    }
    
    return patterns;
}

/**
 * Check if a string looks like a field label
 */
function isFieldLabel(text, field) {
    if (!text || !field) return false;
    
    const labels = FIELD_LABELS[field];
    if (!labels) return false;
    
    const textLower = text.toLowerCase().trim();
    return labels.some(label => textLower.includes(label.toLowerCase()));
}

/**
 * Detect field from label text
 */
function detectFieldFromLabel(labelText) {
    if (!labelText) return null;
    
    const textLower = labelText.toLowerCase().trim();
    
    for (const [field, labels] of Object.entries(FIELD_LABELS)) {
        if (labels.some(label => textLower.includes(label.toLowerCase()))) {
            return field;
        }
    }
    
    return null;
}

// Pre-built patterns
const LABEL_PATTERNS = buildLabelPatterns();

module.exports = {
    FIELD_LABELS,
    LABEL_PATTERNS,
    buildLabelPatterns,
    isFieldLabel,
    detectFieldFromLabel,
};
