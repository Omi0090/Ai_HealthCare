"""
generate_dataset.py
-------------------
Builds a realistic, fully synthetic healthcare-insurance claim ledger used to
train and evaluate the detection models.

We simulate a payer environment with three populations:

  * providers  - hospitals, clinics, labs, pharmacies with specialties,
                 licences, in/out-of-network status and (rarely) a fraud history
  * members    - policy holders with age, chronic conditions, policy age
  * claims     - the billing events, generated from a *latent* archetype:
                 legitimate care, or one of seven documented fraud schemes.

Because the label is the generating archetype we get ground truth without any
privacy concerns - the whole dataset is fabricated (see docs/DATASET.md).

Fraud archetypes (mirrors the literature + real payer SIU workflows):
  1. upcoding               - billing a costlier code than the service performed
  2. phantom_billing        - services never rendered (huge units/volume)
  3. duplicate_billing      - the same claim re-submitted with small edits
  4. unbundling             - one bundled procedure billed as many components
  5. los_inflation          - length of stay / service days inflated
  6. collusion_ring         - provider + member network churning claims
  7. identity_misuse        - member policy details inconsistent with the service

Usage:  python3 generate_dataset.py --rows 7000 --out data/claims.csv
"""

from __future__ import annotations

import argparse
import json
import os
import random
import string
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

RNG = np.random.default_rng(20240517)
random.seed(20240517)

SPECIALTIES = {
    #  specialty            risk   benchmark_cost  diag_prefixes
    "Cardiology":          (0.52, 95_000,  ["I10", "I25", "I48", "I50"]),
    "Orthopedics":         (0.60, 120_000, ["M17", "M54", "S72", "M75"]),
    "Oncology":            (0.56, 150_000, ["C50", "C34", "C18", "C61"]),
    "Dermatology":         (0.20, 8_000,   ["L20", "L40", "L70", "L81"]),
    "General Medicine":    (0.34, 15_000,  ["E11", "J18", "A09", "N39"]),
    "Radiology":           (0.46, 12_000,  ["R91", "Z01", "S62", "K80"]),
    "Pathology":           (0.42, 4_000,   ["D64", "E03", "B18", "N18"]),
    "Pharmacy":            (0.64, 6_000,   ["E78", "I10", "G43", "M79"]),
    "Dentistry":           (0.26, 9_000,   ["K02", "K04", "K08", "K05"]),
    "Ophthalmology":       (0.18, 25_000,  ["H25", "H40", "H52", "H26"]),
    "Neurology":           (0.44, 60_000,  ["G40", "G20", "G35", "G43"]),
    "Gastroenterology":    (0.38, 45_000,  ["K21", "K57", "K29", "K50"]),
}

PROCEDURES = {
    "Cardiology": ["Coronary angioplasty", "Echocardiogram", "Pacemaker implant", "ECG stress test"],
    "Orthopedics": ["Total knee replacement", "Arthroscopy", "Spinal fusion", "Fracture fixation"],
    "Oncology": ["Chemotherapy cycle", "Radiation fraction", "Tumour excision", "PET-CT scan"],
    "Dermatology": ["Excision biopsy", "Laser therapy", "Cryotherapy", "Patch testing"],
    "General Medicine": ["Consultation", "IV hydration", "Wound dressing", "Nebulisation"],
    "Radiology": ["MRI brain", "CT abdomen", "Ultrasound", "X-ray chest"],
    "Pathology": ["Complete blood count", "Lipid panel", "Culture sensitivity", "Biopsy panel"],
    "Pharmacy": ["Prescription refill", "Specialty drug dispense", "Immunosuppressant", "Insulin pack"],
    "Dentistry": ["Root canal", "Dental extraction", "Scaling", "Crown fitting"],
    "Ophthalmology": ["Cataract surgery", "Retinal scan", "Glaucoma screening", "LASIK consult"],
    "Neurology": ["EEG", "Nerve conduction study", "Lumbar puncture", "Epilepsy review"],
    "Gastroenterology": ["Endoscopy", "Colonoscopy", "Liver biopsy", "ERCP"],
}

DIAG_NAMES = {
    "I10": "Essential hypertension", "I25": "Chronic ischaemic heart disease",
    "I48": "Atrial fibrillation", "I50": "Congestive heart failure",
    "M17": "Osteoarthritis of knee", "M54": "Dorsalgia", "S72": "Femur fracture",
    "M75": "Shoulder lesion", "C50": "Breast neoplasm", "C34": "Bronchus neoplasm",
    "C18": "Colon neoplasm", "C61": "Prostate neoplasm", "L20": "Atopic dermatitis",
    "L40": "Psoriasis", "L70": "Acne vulgaris", "L81": "Pigmentation disorder",
    "E11": "Type 2 diabetes mellitus", "J18": "Pneumonia", "A09": "Infective gastroenteritis",
    "N39": "Urinary tract infection", "R91": "Lung mass on imaging", "Z01": "Screening encounter",
    "S62": "Wrist fracture", "K80": "Cholelithiasis", "D64": "Anaemia", "E03": "Hypothyroidism",
    "B18": "Chronic viral hepatitis", "N18": "Chronic kidney disease", "E78": "Lipid disorder",
    "G43": "Migraine", "M79": "Soft tissue disorder", "K02": "Dental caries",
    "K04": "Pulp disorder", "K08": "Dental restoration failure", "K05": "Gingivitis",
    "H25": "Senile cataract", "H40": "Glaucoma", "H52": "Refractive error", "H26": "Lens opacity",
    "G40": "Epilepsy", "G20": "Parkinson disease", "G35": "Multiple sclerosis",
    "K21": "Reflux disease", "K57": "Diverticular disease", "K29": "Gastritis",
    "K50": "Crohn disease",
}

STATES = ["Maharashtra", "Karnataka", "Delhi", "Tamil Nadu", "Gujarat", "Telangana",
          "West Bengal", "Kerala", "Rajasthan", "Uttar Pradesh"]

CITIES = {
    "Maharashtra": ["Pune", "Mumbai", "Nagpur", "Nashik"],
    "Karnataka": ["Bengaluru", "Mysuru", "Hubballi"],
    "Delhi": ["New Delhi", "Dwarka"],
    "Tamil Nadu": ["Chennai", "Coimbatore", "Madurai"],
    "Gujarat": ["Ahmedabad", "Surat", "Vadodara"],
    "Telangana": ["Hyderabad", "Warangal"],
    "West Bengal": ["Kolkata", "Siliguri"],
    "Kerala": ["Kochi", "Thiruvananthapuram"],
    "Rajasthan": ["Jaipur", "Jodhpur"],
    "Uttar Pradesh": ["Lucknow", "Noida", "Varanasi"],
}

CLAIM_TYPES = ["inpatient", "outpatient", "pharmacy", "laboratory", "dental", "vision"]
CLAIM_TYPE_WEIGHTS = [0.30, 0.31, 0.17, 0.13, 0.05, 0.04]
PLAN_TYPES = ["Individual", "Family Floater", "Corporate", "Senior Citizen", "Critical Illness"]
PLAN_WEIGHTS = [0.27, 0.33, 0.24, 0.11, 0.05]

FIRST_NAMES = ["Aarav", "Vivaan", "Aditya", "Ishaan", "Kabir", "Reyansh", "Arjun", "Rohan",
               "Ananya", "Diya", "Aadhya", "Saanvi", "Myra", "Anika", "Kiara", "Riya",
               "Neha", "Priya", "Karan", "Rahul", "Siddharth", "Meera", "Tara", "Vikram"]
LAST_NAMES = ["Sharma", "Patil", "Iyer", "Desai", "Nair", "Reddy", "Gupta", "Mehta",
              "Kulkarni", "Chatterjee", "Bose", "Rao", "Joshi", "Menon", "Singh", "Verma"]

ARCHETYPES = ["legitimate", "upcoding", "phantom_billing", "duplicate_billing",
              "unbundling", "los_inflation", "collusion_ring", "identity_misuse"]
#  Base fraud mass is ~4.6% and the risk lift roughly doubles it, landing the
#  ledger at a ~9-11% fraud prevalence: low enough to be a hard imbalanced
#  learning problem, high enough to train and demo with.
ARCHETYPE_WEIGHTS = [0.954, 0.0057, 0.0063, 0.0055, 0.0058, 0.0061, 0.0073, 0.0073]

IDX_LETTERS = string.ascii_uppercase


def pid(prefix: str, i: int) -> str:
    return f"{prefix}{i:05d}"


def make_providers(n: int) -> pd.DataFrame:
    rows = []
    specs = list(SPECIALTIES.keys())
    ring_ids = set(RNG.choice(n, size=8, replace=False))
    for i in range(n):
        spec = specs[i % len(specs)]
        _, bench, _ = SPECIALTIES[spec]
        state = random.choice(STATES)
        rows.append(
            {
                "provider_id": pid("PRV", i + 1),
                "provider_name": f"{random.choice(LAST_NAMES)} {spec.split()[0]} "
                                 f"{random.choice(['Hospital', 'Clinic', 'Care Centre', 'Diagnostics', 'Medical Institute'])}",
                "specialty": spec,
                "city": random.choice(CITIES[state]),
                "state": state,
                "licence_number": f"MH-{random.randint(100000, 999999)}",
                "license_age_years": round(float(np.clip(RNG.normal(11, 6), 0.5, 45)), 1),
                "in_network": bool(RNG.random() > 0.22),
                "fraud_history": int(RNG.choice([0, 0, 0, 0, 0, 0, 0, 1, 1, 2])),
                "ring_member": i in ring_ids,
                "benchmark_cost": bench,
                "peer_avg_billed": round(float(bench * np.clip(RNG.normal(0.98, 0.16), 0.4, 2.2)), 2),
                "risk_prior": SPECIALTIES[spec][0],
            }
        )
    return pd.DataFrame(rows)


def make_members(n: int) -> pd.DataFrame:
    rows = []
    ring_ids = set(RNG.choice(n, size=30, replace=False))
    for i in range(n):
        age = int(np.clip(RNG.normal(42, 17), 1, 92))
        chronic = int(RNG.poisson(0.35 if age < 40 else 1.6 if age < 65 else 2.6))
        state = random.choice(STATES)
        plan = random.choices(PLAN_TYPES, PLAN_WEIGHTS)[0]
        policy_age = int(np.clip(RNG.exponential(48) + 1, 1, 260))
        premium = {
            "Individual": 24_000, "Family Floater": 42_000, "Corporate": 36_000,
            "Senior Citizen": 58_000, "Critical Illness": 65_000,
        }[plan]
        rows.append(
            {
                "member_id": pid("MEM", i + 1),
                "member_name": f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}",
                "member_age": age,
                "gender": random.choice(["Male", "Female"]),
                "city": random.choice(CITIES[state]),
                "state": state,
                "plan_type": plan,
                "policy_age_months": policy_age,
                "chronic_conditions": chronic,
                "annual_premium": round(float(premium * np.clip(RNG.normal(1, 0.18), 0.6, 2.0)), 2),
                "ring_member": i in ring_ids,
            }
        )
    return pd.DataFrame(rows)


def choose_archetype(provider: pd.Series, member: pd.Series) -> str:
    """Fraud probability is lifted by provider/member risk priors."""
    lift = 1.0
    if provider["fraud_history"] > 0:
        lift *= 3.2
    if not provider["in_network"]:
        lift *= 1.5
    if provider["ring_member"] and member["ring_member"]:
        lift *= 6.0
    if member["policy_age_months"] < 6:
        lift *= 1.7
    if provider["risk_prior"] > 0.55:
        lift *= 1.25

    weights = np.array(ARCHETYPE_WEIGHTS, dtype=float)
    weights[1:] *= lift
    weights = weights / weights.sum()
    if provider["ring_member"] and member["ring_member"] and RNG.random() < 0.55:
        return "collusion_ring"
    return str(RNG.choice(ARCHETYPES, p=weights))


def generate_claims(n_claims: int, providers: pd.DataFrame, members: pd.DataFrame) -> pd.DataFrame:
    peer_avg = providers.set_index("provider_id")["peer_avg_billed"].to_dict()
    prov_by_id = providers.set_index("provider_id")
    mem_by_id = members.set_index("member_id")

    spec_amounts = {
        s: (float(np.mean([p for p in providers["peer_avg_billed"]])), float(np.std(providers["peer_avg_billed"])))
        for s in SPECIALTIES
    }

    provider_ids = providers["provider_id"].to_numpy()
    member_ids = members["member_id"].to_numpy()

    # Pre-compute provider workload so "provider_claims_30d" is realistic
    provider_load = {p: int(np.clip(RNG.normal(38, 18), 4, 180)) for p in provider_ids}

    rows = []
    base_date = datetime(2025, 6, 1)

    for i in range(n_claims):
        # Fraudulent providers generate more claims (selection bias seen in real ledgers)
        if RNG.random() < 0.45:
            hot = providers.sample(1, random_state=int(RNG.integers(0, 1e6))).iloc[0]
            provider = prov_by_id.loc[hot["provider_id"]]
        else:
            provider = prov_by_id.loc[random.choice(provider_ids)]

        prov_key = provider.name
        if provider["ring_member"] and RNG.random() < 0.6:
            member = mem_by_id.loc[random.choice(members[members["ring_member"]]["member_id"].to_numpy())]
        else:
            member = mem_by_id.loc[random.choice(member_ids)]

        member_key = member.name
        archetype = choose_archetype(provider, member)
        spec = provider["specialty"]
        bench = SPECIALTIES[spec][1]
        diag_codes = SPECIALTIES[spec][2]

        claim_type = random.choices(CLAIM_TYPES, CLAIM_TYPE_WEIGHTS)[0]
        if spec == "Pharmacy":
            claim_type = "pharmacy" if RNG.random() < 0.75 else claim_type
        if spec == "Pathology" and RNG.random() < 0.6:
            claim_type = "laboratory"
        if spec == "Dentistry":
            claim_type = "dental"
        if spec == "Ophthalmology" and RNG.random() < 0.5:
            claim_type = "vision"

        procedure = random.choice(PROCEDURES[spec])
        diagnosis = random.choice(diag_codes)
        service_date = base_date + timedelta(days=int(RNG.integers(0, 300)))
        submission_date = service_date + timedelta(days=int(np.clip(RNG.normal(4, 2.5), 0, 45)))

        num_procedures = 1
        units = 1
        service_days = 1
        nights = 0
        diag_proc_match = 1.0
        duplicate_similarity = 0.02
        age_service_mismatch = 0.0
        severity = float(np.clip(RNG.normal(0.45, 0.18), 0.05, 0.98))
        is_emergency = bool(RNG.random() < 0.16)
        pharmacy_qty = 1
        refill_days = 30
        amount_billed = 0.0
        amount_approved = 0.0
        same_day_claims = 0

        # --- legitimate baseline -------------------------------------------
        if claim_type == "inpatient":
            service_days = int(np.clip(RNG.poisson(4) + 1, 1, 21))
            nights = max(service_days - 1, 0)
            amount_billed = bench * np.clip(RNG.normal(0.95, 0.28), 0.25, 2.1)
            num_procedures = int(np.clip(RNG.poisson(2) + 1, 1, 7))
            amount_approved = amount_billed * np.clip(RNG.normal(0.78, 0.10), 0.35, 0.98)
        elif claim_type in ("outpatient", "dental", "vision"):
            amount_billed = bench * np.clip(RNG.normal(0.42, 0.18), 0.08, 1.6)
            amount_approved = amount_billed * np.clip(RNG.normal(0.72, 0.12), 0.3, 0.98)
            units = int(np.clip(RNG.poisson(1.4) + 1, 1, 5))
        elif claim_type == "pharmacy":
            pharmacy_qty = int(np.clip(RNG.poisson(2) + 1, 1, 6))
            refill_days = random.choice([15, 30, 30, 60, 90])
            amount_billed = bench * 0.55 * np.clip(RNG.normal(1.0, 0.3), 0.2, 3.0) * (pharmacy_qty / 2)
            amount_approved = amount_billed * np.clip(RNG.normal(0.80, 0.09), 0.4, 0.99)
        else:  # laboratory
            amount_billed = bench * np.clip(RNG.normal(1.1, 0.35), 0.2, 3.0)
            amount_approved = amount_billed * np.clip(RNG.normal(0.75, 0.10), 0.35, 0.98)
            units = int(np.clip(RNG.poisson(2) + 1, 1, 8))

        same_day_claims = int(np.clip(RNG.poisson(0.12), 0, 3))
        if member["chronic_conditions"] >= 3:
            severity = float(np.clip(severity + 0.18, 0, 1))

        # Benign coding noise: real ledgers are messy. A few percent of honest
        # claims carry data-quality defects (clerk typos, late resubmissions,
        # diagnosis/procedure coding drift). Without this the models look
        # superhuman and the demo is worthless.
        diag_proc_match = float(np.clip(RNG.normal(0.94, 0.07), 0.55, 1.0))
        duplicate_similarity = float(np.clip(RNG.exponential(0.055), 0.0, 0.999))
        if RNG.random() < 0.045:                     # honest resubmission
            duplicate_similarity = float(np.clip(RNG.normal(0.78, 0.09), 0.55, 0.97))
        if RNG.random() < 0.05:                      # coding error, not fraud
            diag_proc_match = float(np.clip(RNG.normal(0.60, 0.12), 0.2, 0.85))
        if RNG.random() < 0.03:
            age_service_mismatch = 1.0

        # ------------------------------------------------------------------
        # Fraud severity. Real schemes are NOT uniformly blatant: an SIU sees
        # everything from a single inflated line-item (subtle, must be caught
        # by pattern models) to an industrial-volume phantom operation. We
        # draw a severity in [0.15, 1.0]; the same archetype can be a whisper
        # or a scream. This is what makes the learning problem graded rather
        # than a deterministic rule and what gives SHAP a meaningful spread.
        # ------------------------------------------------------------------
        legit_snapshot = (amount_billed, amount_approved, units, service_days,
                          nights, num_procedures, diag_proc_match,
                          duplicate_similarity, same_day_claims, age_service_mismatch)
        if archetype != "legitimate":
            # Severity is skewed towards subtle: most schemes are small enough
            # to hide inside normal variation for at least some of their
            # signals.
            sev = float(np.clip(RNG.beta(1.7, 2.5), 0.10, 1.0))

        # --- archetype-specific distortion ---------------------------------
        if archetype == "upcoding":
            amount_billed *= np.clip(RNG.normal(2.0, 0.75), 0.9, 5.0)
            amount_approved = amount_billed * np.clip(RNG.normal(0.84, 0.10), 0.5, 0.99)
            units = int(np.clip(RNG.normal(4.2, 2.4), 1, 14))
            diag_proc_match = float(np.clip(diag_proc_match - RNG.normal(0.28, 0.16), 0.05, 1.0))

        elif archetype == "phantom_billing":
            amount_billed *= np.clip(RNG.normal(2.4, 1.1), 0.6, 7.5)
            units = int(np.clip(RNG.normal(11, 6.5), 1, 60))
            num_procedures = int(np.clip(RNG.normal(5.5, 3.2), 1, 22))
            amount_approved = amount_billed * np.clip(RNG.normal(0.88, 0.09), 0.5, 0.999)
            diag_proc_match = float(np.clip(diag_proc_match - RNG.normal(0.30, 0.18), 0.02, 1.0))
            submission_lag_extra = int(RNG.integers(0, 30))
            submission_date = submission_date + timedelta(days=submission_lag_extra)

        elif archetype == "duplicate_billing":
            if RNG.random() < 0.72:
                duplicate_similarity = float(np.clip(RNG.normal(0.90, 0.09), 0.55, 0.999))
            amount_billed *= np.clip(RNG.normal(1.05, 0.2), 0.7, 2.0)
            amount_approved = amount_billed * np.clip(RNG.normal(0.87, 0.09), 0.5, 0.99)
            submission_lag_extra = 0
            submission_date = submission_date + timedelta(days=int(RNG.integers(0, 6)))
            same_day_claims += int(RNG.integers(1, 4))

        elif archetype == "unbundling":
            num_procedures = int(np.clip(RNG.normal(9, 4.5), 2, 30))
            units = int(np.clip(RNG.normal(5.5, 3.2), 1, 25))
            amount_billed *= np.clip(RNG.normal(1.75, 0.7), 0.8, 4.0)
            amount_approved = amount_billed * np.clip(RNG.normal(0.83, 0.10), 0.5, 0.99)
            diag_proc_match = float(np.clip(RNG.normal(0.78, 0.14), 0.25, 1.0))

        elif archetype == "los_inflation":
            service_days = int(np.clip(RNG.normal(13, 6.5), 3, 60))
            nights = service_days - 1
            amount_billed *= np.clip(RNG.normal(1.7, 0.7), 0.7, 4.5)
            amount_approved = amount_billed * np.clip(RNG.normal(0.83, 0.10), 0.5, 0.99)
            severity = float(np.clip(severity * 0.55, 0.05, 0.6))

        elif archetype == "collusion_ring":
            amount_billed *= np.clip(RNG.normal(2.0, 0.85), 0.7, 5.5)
            units = int(np.clip(RNG.normal(7, 4), 1, 25))
            same_day_claims = int(np.clip(RNG.normal(3.4, 2.4), 0, 12))
            amount_approved = amount_billed * np.clip(RNG.normal(0.88, 0.08), 0.55, 0.999)
            diag_proc_match = float(np.clip(RNG.normal(0.68, 0.2), 0.1, 1.0))

        elif archetype == "identity_misuse":
            if RNG.random() < 0.65:
                age_service_mismatch = 1.0
            amount_billed *= np.clip(RNG.normal(1.6, 0.7), 0.6, 4.5)
            amount_approved = amount_billed * np.clip(RNG.normal(0.86, 0.10), 0.5, 0.99)
            if member["member_age"] < 18:
                claim_type = "outpatient"
                num_procedures = int(np.clip(RNG.normal(3.5, 2), 1, 12))

        # apply severity: interpolate between the honest baseline and the
        # full-strength distortion of this archetype
        if archetype != "legitimate":
            def blend(fraud_val, legit_val):
                return legit_val + (fraud_val - legit_val) * sev
            (l_amt, l_app, l_units, l_days, l_nights, l_proc,
             l_dpm, l_dup, l_same, l_age) = legit_snapshot
            amount_billed = float(blend(amount_billed, l_amt))
            amount_approved = float(blend(amount_approved, l_app))
            units = int(round(blend(units, l_units)))
            service_days = int(round(blend(service_days, l_days)))
            nights = int(round(blend(nights, l_nights)))
            num_procedures = int(round(blend(num_procedures, l_proc)))
            diag_proc_match = float(blend(diag_proc_match, l_dpm))
            duplicate_similarity = float(blend(duplicate_similarity, l_dup))
            same_day_claims = int(round(blend(same_day_claims, l_same)))
            age_service_mismatch = float(1.0 if (age_service_mismatch * sev) > 0.5 else l_age)

            # Signal dropout: a fraudster does not trip *every* red flag on
            # *every* claim. Each distorted signal is independently withheld
            # with probability 0.3, which produces the heterogeneous, partially
            # observable evidence an investigator actually works with - and it
            # stops the models from learning "fraud == one perfect rule".
            def keep(p_keep: float = 0.70) -> bool:
                return bool(RNG.random() < p_keep)

            if not keep():
                amount_billed = l_amt
                amount_approved = l_app
            if not keep():
                units = l_units
            if not keep():
                service_days, nights = l_days, l_nights
            if not keep(0.6):
                num_procedures = l_proc
            if not keep(0.6):
                diag_proc_match = l_dpm
            if not keep(0.5):
                duplicate_similarity = l_dup
            if not keep(0.5):
                same_day_claims = l_same
            if not keep(0.5):
                age_service_mismatch = l_age
        else:
            sev = 0.0

        # clamp
        amount_billed = float(np.clip(amount_billed, 300, 4_500_000))
        amount_approved = float(np.clip(amount_approved, 0, amount_billed))
        units = int(np.clip(units, 1, 80))
        service_days = int(np.clip(service_days, 0, 90))
        nights = int(np.clip(nights, 0, 90))
        num_procedures = int(np.clip(num_procedures, 1, 40))

        # Claim-frequency signals: fraud rings churn claims, but plenty of
        # honest chronically-ill members also claim often - heavy overlap is
        # what makes this a genuinely hard learning problem.
        if archetype == "legitimate":
            prior_claims_30d = int(np.clip(RNG.poisson(0.5), 0, 30))
            member_claims_12m = int(np.clip(RNG.poisson(1.5), 0, 60))
            provider_claims_30d = int(np.clip(provider_load[prov_key] * RNG.normal(1.0, 0.16), 3, 260))
        else:
            prior_claims_30d = int(np.clip(RNG.poisson(0.5 + 0.7 * sev), 0, 30))
            member_claims_12m = int(np.clip(RNG.poisson(1.5 + 1.5 * sev), 0, 60))
            provider_claims_30d = int(np.clip(
                provider_load[prov_key] * np.clip(RNG.normal(1.0 + 0.5 * sev, 0.45), 0.6, 4.0), 3, 420))
        # Geo distance: most care is local, but members do travel (referrals,
        # family hometowns, medical tourism), so the signal is fuzzy on purpose.
        distance = float(np.clip(RNG.lognormal(2.6, 0.9), 0.5, 1200))
        if archetype == "collusion_ring":
            distance = float(np.clip(RNG.normal(190, 140), 2, 1200))

        mean_, std_ = spec_amounts[spec]
        rows.append(
            {
                "claim_id": f"CLM-{service_date.year}-{i + 1:06d}",
                "service_date": service_date.strftime("%Y-%m-%d"),
                "submission_date": submission_date.strftime("%Y-%m-%d"),
                "provider_id": prov_key,
                "provider_name": provider["provider_name"],
                "specialty": spec,
                "state": provider["state"],
                "city": provider["city"],
                "provider_license_age_years": provider["license_age_years"],
                "provider_fraud_history": provider["fraud_history"],
                "provider_in_network": int(provider["in_network"]),
                "provider_avg_billed": peer_avg[prov_key],
                "member_id": member_key,
                "member_name": member["member_name"],
                "member_age": int(member["member_age"]),
                "plan_type": member["plan_type"],
                "policy_age_months": int(member["policy_age_months"]),
                "chronic_conditions": int(member["chronic_conditions"]),
                "annual_premium": float(member["annual_premium"]),
                "claim_type": claim_type,
                "procedure_code": procedure,
                "diagnosis_code": diagnosis,
                "diagnosis_severity": round(severity, 3),
                "is_emergency": int(is_emergency),
                "amount_billed": round(amount_billed, 2),
                "amount_approved": round(amount_approved, 2),
                "units_claimed": units,
                "service_days": service_days,
                "nights_in_hospital": nights,
                "num_procedures": num_procedures,
                "prior_claims_30d": prior_claims_30d,
                "member_claims_12m": member_claims_12m,
                "provider_claims_30d": int(provider_claims_30d),
                "same_day_claims": int(same_day_claims),
                "duplicate_similarity": round(duplicate_similarity, 3),
                "diag_proc_match": round(diag_proc_match, 3),
                "age_service_mismatch": age_service_mismatch,
                "submission_lag_days": (submission_date - service_date).days,
                "is_weekend_submission": int(submission_date.weekday() >= 5),
                "distance_km": round(distance, 2),
                "pharmacy_qty": int(pharmacy_qty),
                "pharmacy_refill_days": int(refill_days),
                "specialty_amount_mean": round(mean_, 2),
                "specialty_amount_std": round(std_, 2),
                "archetype": archetype,
                "fraud_severity": round(sev, 3),
                "is_fraud": int(archetype != "legitimate"),
            }
        )
    return pd.DataFrame(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=7000)
    ap.add_argument("--providers", type=int, default=160)
    ap.add_argument("--members", type=int, default=1100)
    ap.add_argument("--out", type=str, default="data/claims.csv")
    ap.add_argument("--json", type=str, default="data/claims_seed.json")
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    providers = make_providers(args.providers)
    members = make_members(args.members)
    claims = generate_claims(args.rows, providers, members)

    claims.to_csv(args.out, index=False)
    meta = {
        "providers": providers.to_dict(orient="records"),
        "members": members.to_dict(orient="records"),
        "diagnoses": DIAG_NAMES,
    }
    with open(args.json, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=1)

    rate = claims["is_fraud"].mean()
    print(f"wrote {len(claims)} claims -> {args.out}")
    print(f"fraud prevalence: {rate:.2%}")
    print(claims["archetype"].value_counts())
    print(f"providers={len(providers)} members={len(members)}")


if __name__ == "__main__":
    main()
