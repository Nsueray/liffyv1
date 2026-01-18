/**
 * pipeline/index.js - SuperMiner v3.1
 * 
 * Central export for validation pipeline modules.
 */

const validatorV2 = require('./validatorV2');
const hallucinationFilter = require('./hallucinationFilter');

module.exports = {
    // ValidatorV2
    validateContact: validatorV2.validateContact,
    validateContacts: validatorV2.validateContacts,
    validateEmail: validatorV2.validateEmail,
    validatePhone: validatorV2.validatePhone,
    validateWebsite: validatorV2.validateWebsite,
    validateName: validatorV2.validateName,
    validateCompany: validatorV2.validateCompany,
    isGarbageEmail: validatorV2.isGarbageEmail,
    isGenericProviderEmail: validatorV2.isGenericProviderEmail,
    
    // Hallucination Filter
    filterHallucinations: hallucinationFilter.filterHallucinations,
    detectHallucination: hallucinationFilter.detectHallucination,
    adjustConfidenceByEvidence: hallucinationFilter.adjustConfidenceByEvidence,
    validateEvidence: hallucinationFilter.validateEvidence,
    createEvidence: hallucinationFilter.createEvidence,
    EVIDENCE_TYPES: hallucinationFilter.EVIDENCE_TYPES,
    EVIDENCE_RELIABILITY: hallucinationFilter.EVIDENCE_RELIABILITY,
    
    // Full modules
    validatorV2,
    hallucinationFilter
};
